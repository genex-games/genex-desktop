/**
 * The Rust · wgpu creation gate. A developer build makes a Rust game on any host; a release build
 * makes one only where the Rust lane runs and the store pins its toolchain (`rustDefaultHost`: an
 * Apple-silicon Mac and the Linux Studio, M6.4) and refuses it `stack-gated` elsewhere (Windows,
 * an Intel Mac) before anything is written. The gate does not follow the default-stack switch:
 * reverted, Three.js is the default and Rust · wgpu stays an explicit choice. The core's
 * `developmentStacks` option overrides the build's own answer (tests, fixture profiles).
 */
import { rustDefaultHost } from "../../shared/toolchain.ts";

/** Set by `scripts/build.mjs`: a developer build's checkout, or null in a release build; absent from source. */
declare const __STUDIO_DEV_BUILD__: { checkout: string; buildId: string } | null | undefined;

/** Whether this app is a release build: built, and from no developer checkout. */
function isReleaseBuild(): boolean {
  return typeof __STUDIO_DEV_BUILD__ !== "undefined" && __STUDIO_DEV_BUILD__ === null;
}

/** What decides the gate: the core's option, when it names one. */
export interface StackGateOptions {
  /** Open (true) or closed (false); absent, the build and the host decide (see {@link developmentStacksOpen}). */
  developmentStacks?: boolean;
}

/** The build and computer the gate is decided for: this app's own unless a test names another. */
export interface StackGateBuild {
  /** A release build (no developer checkout). */
  release: boolean;
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
}

/** This app's build and computer. */
function thisBuild(): StackGateBuild {
  return { release: isReleaseBuild(), platform: process.platform, arch: process.arch };
}

/**
 * Whether Rust · wgpu creation is open for a core with these options: the option when it names
 * one, else open in every developer build and, in a release build, where the Rust lane runs.
 */
export function developmentStacksOpen(options: StackGateOptions, build: StackGateBuild = thisBuild()): boolean {
  if (options.developmentStacks !== undefined) return options.developmentStacks;
  return !build.release || rustDefaultHost(build.platform, build.arch) !== null;
}
