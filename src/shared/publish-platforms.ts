/**
 * The platforms a game can be published for, as the Publish dialog lists them (canvas board
 * "Publish"): the web, Mac and Windows, always all three. What was built is what is published: a
 * row's state comes from the build in the game folder, never from the author's words. Until
 * genex.games takes native builds, a built Mac or Windows app shows its state and publishes nothing
 * (`uploads: false`, "Coming soon").
 */
import type { NativeArch, NativePlatform } from "./play-native.ts";

/** A row's platform. Wire values: never rename one. */
export const PublishTarget = { Web: "web", Mac: "mac", Windows: "windows" } as const;
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
