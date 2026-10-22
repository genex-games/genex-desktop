/**
 * The platforms a game can be published for, as the Publish dialog lists them (canvas board
 * "Publish"): the web, Mac, Windows and Linux, always all four. What was built is what is published:
 * a row's state comes from the build in the game folder, never from the author's words. While the
 * Genex CLI cannot send native builds, a built app shows its state and publishes nothing
 * (`uploads: false`, "Coming soon").
 */
import type { NativeArch, NativePlatform } from "./play-native.ts";

/** A row's platform. Wire values: never rename one. */
export const PublishTarget = { Web: "web", Mac: "mac", Windows: "windows", Linux: "linux" } as const;
export type PublishTarget = (typeof PublishTarget)[keyof typeof PublishTarget];

/** The rows in the order the dialog lists them. */
export const PUBLISH_TARGETS: readonly PublishTarget[] = Object.values(PublishTarget);

/** Where a platform stands. Wire values: never rename one. */
export const PublishPlatformState = {
  /** Built, and not older than the game's last change: it is published. */
  Ready: "ready",
  /** Built before the game's last change: built again, it is published. */
  Stale: "stale",
  /** Nothing built for it yet. */
  Missing: "missing",
} as const;
export type PublishPlatformState = (typeof PublishPlatformState)[keyof typeof PublishPlatformState];

/** One platform's row. */
export interface PublishPlatform {
  target: PublishTarget;
  state: PublishPlatformState;
  /** The build's processors (`universal`, `arm64`, `x64`); none for the web or a missing build. */
  arch: NativeArch | null;
  /** The space the build takes; 0 for none. */
  bytes: number;
  /** When it was built, ISO 8601, or null. */
  builtAt: string | null;
  /** Whether Publish sends it now: the web build does, a native build not until genex.games takes them. */
  uploads: boolean;
}

/** A row's platform as the builds' contract names it, or null for the web. */
export const nativePlatformOf = (target: PublishTarget): NativePlatform | null =>
  target === PublishTarget.Web ? null : target;

/** The Unreal folder a Linux game's program sits in: `<Game>/Binaries/Linux/<program>`. */
const UNREAL_LINUX_BINARIES = new Set(["Linux", "LinuxArm64"]);

/**
 * What a Linux build found at `entry` (its program, `/`-separated, relative to the game folder) ships
 * as: the folder sent, and the program inside it. A Unity or Godot program sits beside its data, so
 * its own folder is the build; an Unreal one sits in `<Game>/Binaries/Linux/` under the package,
 * whose root (with its Engine folder and `.sh` starter) is the build. Null for a program with no
 * folder of its own (one at the game folder's root).
 */
export function linuxBuildOf(entry: string): { folder: string; entry: string } | null {
  const parts = entry.split("/");
  const unreal = parts.length >= 5 && parts.at(-3) === "Binaries" && UNREAL_LINUX_BINARIES.has(parts.at(-2) ?? "");
  const inside = unreal ? 4 : 1;
  if (parts.length <= inside) return null;
  return { folder: parts.slice(0, -inside).join("/"), entry: parts.slice(-inside).join("/") };
}
