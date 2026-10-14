/**
 * Per-stack setup: which destinations a compiled stack's managed setup prepares on each host,
 * whether its lane runs there, and the prerequisites that sit outside the store (Apple's Command
 * Line Tools or Xcode, the Android SDK with its licence, a JDK). Generalizes `cpp-setup.ts`, which
 * now reads the raylib rows here. Browser-safe: the renderer imports it.
 */
import { StudioPlatform } from "./boot.ts";
import { ALL_BUILD_TARGETS, BuildTarget, GameStack, isCompiledStack, MOBILE_TARGETS } from "./game-project.ts";
import { STACK_HOST_MATRIX } from "./game-targets.ts";
import { LANE_PLATFORMS, rustCrossPinned, ToolchainHost } from "./toolchain.ts";

/** The platform each manifest host is. */
const HOST_PLATFORM = {
  [ToolchainHost.MacArm64]: StudioPlatform.Mac,
  [ToolchainHost.WindowsX64]: StudioPlatform.Windows,
  [ToolchainHost.LinuxX64]: StudioPlatform.Linux,
} as const satisfies Record<ToolchainHost, StudioPlatform>;

/**
 * Whether `stack`'s build lane runs on `platform`, per {@link LANE_PLATFORMS}. Three.js has none;
 * no compiled lane runs on Windows yet, whose sandbox cannot grant a write to one build.
 */
export function laneRunsOn(stack: GameStack, platform: string): boolean {
  if (!isCompiledStack(stack)) return false;
  const platforms: readonly string[] = LANE_PLATFORMS[stack];
  return platforms.includes(platform);
}

/**
 * Whether this build's lane for `stack` has a builder for `target`: a Rust cross destination's
 * registers only once the Rust recipe pins its components ({@link rustCrossPinned}).
 */
export function laneBuilderReady(stack: GameStack, target: BuildTarget): boolean {
  if (stack !== GameStack.RustWgpu) return true;
  if (target !== BuildTarget.Windows && target !== BuildTarget.Linux) return true;
  return rustCrossPinned(target);
}

/**
 * What `stack`'s setup prepares on `host`, independent of any game's chosen destinations: what
 * the host builds for the stack where its lane runs and has a builder ({@link laneBuilderReady}),
 * else nothing. The phones are never among them: their tools are the person's own (Xcode, the
 * Android SDK and its licence) and the phone setup rows prepare the rest
 * (`studio:toolchain.installMobile`). A null host (an Intel Mac, or a platform with no pinned
 * toolchain) prepares nothing.
 */
export function setupTargets(stack: GameStack, host: ToolchainHost | null): readonly BuildTarget[] {
  if (!host) return [];
  const platform = HOST_PLATFORM[host];
  if (!laneRunsOn(stack, platform)) return [];
  const builds: readonly BuildTarget[] = STACK_HOST_MATRIX[stack][platform].build;
  return builds.filter((target) => !MOBILE_TARGETS.includes(target) && laneBuilderReady(stack, target));
}

/** A prerequisite the store does not install. Sent to the renderer: never rename a value. */
export const SetupPrerequisite = {
  /** Apple's Command Line Tools: the Mac linker and SDK (Xcode also provides them). */
  Clt: "clt",
  /** Xcode with the iOS SDK: iPhone and iPad builds. */
  Xcode: "xcode",
  /** The Android SDK (platform and build tools). */
  AndroidSdk: "android-sdk",
  /** The Android SDK licence, accepted by a person in the sheet, never by an agent. */
  AndroidLicence: "android-licence",
  /** A Java runtime for the Android packaging tools. */
  Jdk: "jdk",
} as const;
export type SetupPrerequisite = (typeof SetupPrerequisite)[keyof typeof SetupPrerequisite];

/** Whether a tool is on this computer, and its version when it said. */
export interface ToolPresence {
  present: boolean;
  version: string | null;
}

/** The prerequisites outside the store, as the host found them. */
export interface SetupPrerequisites {
  clt: ToolPresence;
  xcode: ToolPresence;
  android: {
    sdk: ToolPresence;
    /** Only a person's press in the sheet sets this. */
    licenceAccepted: boolean;
    jdk: ToolPresence;
  };
}

/** A stack's setup on this computer: what its store prepares and what stands outside it. */
export interface StackSetupStatus {
  stack: GameStack;
  host: ToolchainHost | null;
  /** {@link setupTargets} for this stack and host. */
  targets: readonly BuildTarget[];
  prerequisites: SetupPrerequisites;
}

const ABSENT: ToolPresence = Object.freeze({ present: false, version: null });

/** Nothing found: the state before the host has looked, and what a computer without any tool reports. */
export const EMPTY_PREREQUISITES: SetupPrerequisites = Object.freeze({
  clt: ABSENT,
  xcode: ABSENT,
  android: Object.freeze({ sdk: ABSENT, licenceAccepted: false, jdk: ABSENT }),
});

/** Which prerequisites each destination needs. */
export const PREREQUISITES_OF_TARGET = {
  [BuildTarget.Web]: [],
  [BuildTarget.Mac]: [SetupPrerequisite.Clt],
  [BuildTarget.Windows]: [],
  [BuildTarget.Linux]: [],
  [BuildTarget.Ios]: [SetupPrerequisite.Xcode],
  [BuildTarget.Android]: [SetupPrerequisite.AndroidSdk, SetupPrerequisite.AndroidLicence, SetupPrerequisite.Jdk],
} as const satisfies Record<BuildTarget, readonly SetupPrerequisite[]>;

/** Whether `prerequisite` is satisfied by what the host found. */
function satisfied(found: SetupPrerequisites, prerequisite: SetupPrerequisite): boolean {
  switch (prerequisite) {
    case SetupPrerequisite.Clt:
      return found.clt.present || found.xcode.present;
    case SetupPrerequisite.Xcode:
      return found.xcode.present;
    case SetupPrerequisite.AndroidSdk:
      return found.android.sdk.present;
    case SetupPrerequisite.AndroidLicence:
      return found.android.licenceAccepted;
    case SetupPrerequisite.Jdk:
      return found.android.jdk.present;
  }
}

/** The prerequisites `targets` still lack, each once, in {@link SetupPrerequisite} order. */
export function missingPrerequisites(found: SetupPrerequisites, targets: readonly BuildTarget[]): SetupPrerequisite[] {
  const wanted = ALL_BUILD_TARGETS.filter((target) => targets.includes(target));
  const needed = new Set<SetupPrerequisite>(
    wanted.flatMap((target): readonly SetupPrerequisite[] => PREREQUISITES_OF_TARGET[target]),
  );
  return Object.values(SetupPrerequisite).filter((item) => needed.has(item) && !satisfied(found, item));
}
