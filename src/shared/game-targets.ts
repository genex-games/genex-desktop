/**
 * Where a C++ · raylib game can be built and run, by host: the one table the create dialog, the
 * build lane, the stage badges and the judging pass all read. Browser-safe: the renderer imports it.
 */
import { StudioPlatform } from "./boot.ts";
import { BuildTarget, type GameDestinations, GameStack } from "./game-project.ts";

/** What a host can build and run. */
export interface HostAbility {
  build: readonly BuildTarget[];
  run: readonly BuildTarget[];
}

/**
 * The host matrix. A Mac builds all four and runs Browser + Mac. Windows and Linux hosts build
 * the browser and both cross-targets and run their own OS. On every host the own-OS target runs
 * only through a game box (the Seatbelt game profile on a Mac; bwrap or AppContainer
 * elsewhere); {@link runRefusal} takes whether this build has one.
 */
export const HOST_MATRIX = {
  [StudioPlatform.Mac]: {
    build: [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux],
    run: [BuildTarget.Web, BuildTarget.Mac],
  },
  [StudioPlatform.Windows]: {
    build: [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux],
    run: [BuildTarget.Web, BuildTarget.Windows],
  },
  [StudioPlatform.Linux]: {
    build: [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux],
    run: [BuildTarget.Web, BuildTarget.Linux],
  },
} as const satisfies Record<StudioPlatform, HostAbility>;

/** A host that builds and runs nothing for a stack. */
const NO_LANE_HOST: HostAbility = Object.freeze({ build: Object.freeze([]), run: Object.freeze([]) });

/** The browser only: what every host does for a game with no managed toolchain. */
const WEB_ONLY_HOST: HostAbility = Object.freeze({
  build: Object.freeze([BuildTarget.Web]),
  run: Object.freeze([BuildTarget.Web]),
});

/**
 * What each host can build and run, per stack. Three.js plays in the browser everywhere; raylib
 * is {@link HOST_MATRIX}. Rust · wgpu's lane builds Browser, Mac, Windows and Linux on a Mac and
 * Browser, Windows and Linux on the Linux Studio; it runs the browser everywhere and the Mac's own
 * build on a Mac (no Rust Linux run is prepared or boxed yet). A cross destination's builder
 * registers only while the Rust recipe pins its components (it pins both): without them the lane
 * refuses it `target-unbuilt` and setup offers it nowhere (`setupTargets`, `rustCrossPinned`). The phones
 * are built (and packaged by their exports) on a Mac, Android on the Linux Studio too, and never
 * run by Studio: a Simulator, emulator or phone launch is the person's (containment stage 1). A
 * Windows host stays empty until its sandbox can grant a write to one build (the signed launcher).
 */
export const STACK_HOST_MATRIX = {
  [GameStack.ThreeJs]: {
    [StudioPlatform.Mac]: WEB_ONLY_HOST,
    [StudioPlatform.Windows]: WEB_ONLY_HOST,
    [StudioPlatform.Linux]: WEB_ONLY_HOST,
  },
  [GameStack.RaylibCpp]: HOST_MATRIX,
  [GameStack.RustWgpu]: {
    [StudioPlatform.Mac]: Object.freeze({
      build: Object.freeze([
        BuildTarget.Web,
        BuildTarget.Mac,
        BuildTarget.Windows,
        BuildTarget.Linux,
        BuildTarget.Ios,
        BuildTarget.Android,
      ]),
      run: Object.freeze([BuildTarget.Web, BuildTarget.Mac]),
    }),
    [StudioPlatform.Windows]: NO_LANE_HOST,
    [StudioPlatform.Linux]: Object.freeze({
      build: Object.freeze([BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux, BuildTarget.Android]),
      run: Object.freeze([BuildTarget.Web]),
    }),
  },
} as const satisfies Record<GameStack, Record<StudioPlatform, HostAbility>>;

/** Why a destination is refused, or only labelled, on this host. Never rename a value. */
export const TargetRefusal = {
  /** Apple's SDK licence: Mac games are built on a Mac. */
  MacBuildsNeedAMac: "mac-builds-need-a-mac",
  /** Built here, not run here: the honest label for a cross-build. */
  NotRunnableHere: "not-runnable-here",
  /** The host's own OS, but this build has no game box for it yet. */
  NoGameBox: "no-game-box",
  /** The game's studio.json does not name this destination (desktop targets and exports only: Web always builds for judging). */
  NotADestination: "not-a-destination",
  /** Destinations may be added later; a change that would change the stack is refused. */
  StackIsFixed: "stack-is-fixed",
  /** The game has no destination this host can judge on real frames, and its judging-only web build failed. */
  NoJudgingTarget: "no-judging-target",
  /** The folder records a kind this version of Genex does not know: it opens read-only. */
  KindUnsupported: "kind-unsupported",
  /** The stack is behind the development gate in this build (Rust · wgpu before its release). */
  StackGated: "stack-gated",
  /** The stack's toolchain is not installed and cannot be fetched offline. */
  ToolchainOffline: "toolchain-offline",
} as const;
export type TargetRefusal = (typeof TargetRefusal)[keyof typeof TargetRefusal];

/**
 * What a destination's badge on the stage says about its latest build or check: the
 * renderer's words key on it, and a check that cannot run is never a pass. Never rename a value.
 */
export const DestinationBadge = {
  Building: "building",
  Built: "built",
  Failed: "failed",
  /** A desktop destination with no build recorded: nothing in this version starts a Windows or Linux build yet. */
  NotBuilt: "not-built",
  /** Built here, never run here. */
  NotRunHere: "not-run-here",
  CiPassed: "ci-passed",
  VerifiedInVm: "verified-in-vm",
} as const;
export type DestinationBadge = (typeof DestinationBadge)[keyof typeof DestinationBadge];

/** Which build the evidence pass judges, and whether it is a build no player gets. */
export interface JudgingTarget {
  target: BuildTarget;
  /** A web build made only so judges see real frames: never exported, never shown in Live. */
  judgingOnly: boolean;
}

/** Each host's own OS as a destination. */
const OWN_OS = {
  [StudioPlatform.Mac]: BuildTarget.Mac,
  [StudioPlatform.Windows]: BuildTarget.Windows,
  [StudioPlatform.Linux]: BuildTarget.Linux,
} as const satisfies Record<StudioPlatform, BuildTarget>;

const HOSTS: ReadonlySet<string> = new Set<StudioPlatform>(Object.values(StudioPlatform));

const isHost = (platform: string): platform is StudioPlatform => HOSTS.has(platform);

/** The host, or null on a platform the studio does not build for. */
export function hostOf(platform: string): StudioPlatform | null {
  return isHost(platform) ? platform : null;
}

/** The host's own OS as a destination (a Mac → `macos`). */
export function hostTarget(host: StudioPlatform): BuildTarget {
  return OWN_OS[host];
}

/** null when this host builds `target`; else the refusal. */
export function buildRefusal(host: StudioPlatform, target: BuildTarget): TargetRefusal | null {
  const builds: readonly BuildTarget[] = HOST_MATRIX[host].build;
  return builds.includes(target) ? null : TargetRefusal.MacBuildsNeedAMac;
}

/** null when this host runs `target`; `gameBox` is whether `ProcessSandbox` has a game box for the host's own OS. */
export function runRefusal(
  host: StudioPlatform,
  target: BuildTarget,
  options: { gameBox: boolean },
): TargetRefusal | null {
  const unbuildable = buildRefusal(host, target);
  if (unbuildable) return unbuildable;
  if (target === BuildTarget.Web) return null;
  const runs: readonly BuildTarget[] = HOST_MATRIX[host].run;
  if (!runs.includes(target)) return TargetRefusal.NotRunnableHere;
  return options.gameBox ? null : TargetRefusal.NoGameBox;
}

/**
 * The judging target: Web when Browser is a destination; else the first destination this
 * host runs (`runRefusal` null); else a judging-only Web build. Never null: a failed judging build
 * is the gate's `NoJudgingTarget`, not the picker's.
 */
export function judgingTarget(
  destinations: GameDestinations,
  host: StudioPlatform,
  options: { gameBox: boolean },
): JudgingTarget {
  if (destinations.targets.includes(BuildTarget.Web)) return { target: BuildTarget.Web, judgingOnly: false };
  const runnable = destinations.targets.find((target) => runRefusal(host, target, options) === null);
  if (runnable) return { target: runnable, judgingOnly: false };
  return { target: BuildTarget.Web, judgingOnly: true };
}

/**
 * The badge a destination check of a build made here shows when the gate admitted it: Built where
 * this host runs `target` (given a game box), else NotRunHere ("Built, not run on this Mac"): the
 * honest label for a cross-build, never a pass.
 */
export function crossCheckBadge(host: StudioPlatform, target: BuildTarget): DestinationBadge {
  return runRefusal(host, target, { gameBox: true }) === null ? DestinationBadge.Built : DestinationBadge.NotRunHere;
}
