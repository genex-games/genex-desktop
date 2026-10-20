/**
 * This computer as a native game sees it: its platform, processor and system version. Play reads it
 * to leave out games this computer cannot play and to pick the build it installs.
 */
import { existsSync } from "node:fs";
import { StudioPlatform } from "../../shared/boot.ts";
import { NativeArch, type NativeHost, NativePlatform } from "../../shared/play-native.ts";

/** Node's platform names as the builds' contract spells them. */
const PLATFORM_OF: Readonly<Record<string, NativePlatform>> = {
  [StudioPlatform.Mac]: NativePlatform.Mac,
  [StudioPlatform.Windows]: NativePlatform.Windows,
  [StudioPlatform.Linux]: NativePlatform.Linux,
};

/** The runtime Rosetta installs: an Apple silicon Mac with it runs Intel apps. */
const ROSETTA_RUNTIME = "/Library/Apple/usr/libexec/oah/libRosettaRuntime";

/** Node's processor names as the builds' contract spells them. */
const ARCH_OF: Readonly<Record<string, NativeHost["arch"]>> = { arm64: NativeArch.Arm64, x64: NativeArch.X64 };

/** A system version as Electron reports it: dotted numbers. */
const OS_VERSION = /^\d+(\.\d+)*$/;

/**
 * The computer `platform`, `arch` and `osVersion` describe (this one's by default: Electron's
 * `process.getSystemVersion()` is the macOS or Windows version, not the kernel's), or undefined
 * where the contract has no name for it.
 */
export function thisComputer(
  platform: string = process.platform,
  arch: string = process.arch,
  osVersion: string = process.getSystemVersion?.() ?? "",
  rosetta: () => boolean = () => existsSync(ROSETTA_RUNTIME),
): NativeHost | undefined {
  const named = PLATFORM_OF[platform];
  const processor = ARCH_OF[arch];
  if (!named || !processor) return undefined;
  if (!OS_VERSION.test(osVersion)) return undefined;
  const appleSilicon = named === NativePlatform.Mac && processor === NativeArch.Arm64;
  return { platform: named, arch: processor, osVersion, ...(appleSilicon ? { rosetta: rosetta() } : {}) };
}
