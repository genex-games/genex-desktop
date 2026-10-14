/**
 * Per-stack setup status beside the C++ store's, for `studio:toolchain.status`: Xcode found apart
 * from the Command Line Tools (iPhone and iPad builds need it; a Rust game's Mac build takes either),
 * the Rust · wgpu stack's current lock, and the harness parts a Rust night refuses
 * (`keptPreRustParts`). Each piece answers on its own: one that fails is left out of the status,
 * never failing it.
 */
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { GameStack } from "../../shared/game-project.ts";
import type { ToolPresence } from "../../shared/stack-setup.ts";
import type { ToolchainLock, ToolchainStatus } from "../../shared/toolchain.ts";
import { readRegularFile } from "../../substrate/fsx.ts";
import { keptPreRustParts } from "../../substrate/seed-upgrade.ts";
import type { StudioCore } from "../studio-core.ts";
import { execHost, type HostExec } from "./toolchains.ts";

/** `xcode-select -p` prints the selected developer folder; it never opens Apple's installer. */
const XCODE_SELECT = "/usr/bin/xcode-select";
/** Where the App Store installs Xcode. */
const DEFAULT_XCODE_APP = "/Applications/Xcode.app";
/** How long `xcode-select -p` may take. */
const XCODE_PROBE_TIMEOUT_MS = 10 * SECOND_MS;
/** The most of Xcode's `version.plist` the probe reads. */
const VERSION_PLIST_MAX_BYTES = 64 * 1024;
/** A selected developer folder inside an app bundle: `<…>.app/Contents/Developer`. */
const SELECTED_APP = /^(.+\.app)\/Contents\/Developer\/?$/;
/** Xcode's marketing version in its `version.plist`. */
const SHORT_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,64})<\/string>/;

const ABSENT: ToolPresence = Object.freeze({ present: false, version: null });

/** What the Xcode probe reaches, injected. */
export interface XcodeProbeOptions {
  exec: HostExec;
  platform: string;
  /** Where Xcode is looked for when the selected developer folder is not inside one (default: /Applications/Xcode.app). */
  defaultApp?: string;
}

/** The Xcode bundle `xcode-select -p` names, or null when it names the Command Line Tools or nothing. */
async function selectedApp(exec: HostExec): Promise<string | null> {
  const selected = await exec(XCODE_SELECT, ["-p"], { timeoutMs: XCODE_PROBE_TIMEOUT_MS });
  if (selected.code !== 0) return null;
  return SELECTED_APP.exec(selected.stdout.trim())?.[1] ?? null;
}

/** The version an Xcode bundle's `version.plist` names, read as a plain file only; undefined when it cannot be read. */
async function appVersion(app: string): Promise<string | null | undefined> {
  const plist = await readRegularFile(path.join(app, "Contents", "version.plist"), VERSION_PLIST_MAX_BYTES).catch(
    () => null,
  );
  if (!plist) return undefined;
  return SHORT_VERSION.exec(plist.toString("utf8"))?.[1] ?? null;
}

/**
 * Whether Xcode is on this Mac, and its version: the Xcode `xcode-select -p` names, else the one in
 * the default place, found by its `version.plist` (never through a link). Only `xcode-select -p`
 * runs, never `xcodebuild`, which can stop on Apple's licence prompt. Not a Mac: none.
 */
export async function probeXcode(options: XcodeProbeOptions): Promise<ToolPresence> {
  if (options.platform !== StudioPlatform.Mac) return ABSENT;
  const selected = await selectedApp(options.exec).catch(() => null);
  for (const app of [selected, options.defaultApp ?? DEFAULT_XCODE_APP]) {
    if (app === null) continue;
    const version = await appVersion(app);
    if (version !== undefined) return { present: true, version };
  }
  return ABSENT;
}

/** Where each piece of the per-stack status comes from. */
export interface StackSetupSource {
  xcode: () => Promise<ToolPresence>;
  /** The Rust · wgpu stack's current lock, or null before its first setup. */
  rustLock: () => Promise<ToolchainLock | null>;
  /** The harness parts a Rust night refuses, kept from before Rust games. */
  keptPreRust: () => Promise<string[]>;
}

/** The per-stack fields of `ToolchainStatus`: each piece that answered, and none that failed. */
export type StackSetupFields = Pick<ToolchainStatus, "xcode" | "stackLocks" | "keptPreRust">;

/** Reads every piece of `source` side by side; a piece that throws is left out. */
export async function stackSetupStatus(source: StackSetupSource): Promise<StackSetupFields> {
  const settle = <T>(read: () => Promise<T>) =>
    read()
      .then((value): { value: T } => ({ value }))
      .catch(() => null);
  const [xcode, rustLock, kept] = await Promise.all([
    settle(source.xcode),
    settle(source.rustLock),
    settle(source.keptPreRust),
  ]);
  return {
    ...(xcode ? { xcode: xcode.value } : {}),
    ...(rustLock ? { stackLocks: { [GameStack.RustWgpu]: rustLock.value } } : {}),
    ...(kept ? { keptPreRust: kept.value } : {}),
  };
}

/** The real source over the core: this Mac's Xcode, the store's Rust lock, and the profile's harness workspace. */
export function stackSetupOf(core: Pick<StudioCore, "toolchains" | "options" | "layout">): StackSetupSource {
  return {
    xcode: () => probeXcode({ exec: execHost, platform: process.platform }),
    rustLock: () => core.toolchains.currentLock(GameStack.RustWgpu),
    keptPreRust: () =>
      keptPreRustParts({
        seedDir: path.join(core.options.paths.resources, "harness-seed"),
        workspaceDir: core.layout.harnessWs,
      }),
  };
}
