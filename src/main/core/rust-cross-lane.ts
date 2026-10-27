/**
 * The Rust lane's Windows and Linux destinations as the core registers them (M4.6): the M4.1 and
 * M4.2 builders (`rust-build-windows.ts`, `rust-build-linux.ts`) and their settings over what the
 * profile's toolchain store holds for the build's lock (llvm-mingw; zig, cargo-zigbuild and the
 * Linux sysroot), chained after the phones' settings.
 *
 * A cross destination registers only while the Rust recipe pins its components (it pins both,
 * the SwiftShader split and the Linux headers coming from the app's resources): a
 * `STACK_REQUIRED_COMPONENTS` row missing any of `RUST_CROSS_COMPONENTS` keeps its build refused
 * `target-unbuilt`, so nobody is told to install a toolchain the store cannot fetch.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { BuildTarget, GameStack } from "../../shared/game-project.ts";
import type { CrossBuildTarget } from "../../shared/native-contract.ts";
import {
  rustCrossPinned,
  STACK_REQUIRED_COMPONENTS,
  type StackComponents,
  ToolchainHost,
  ToolchainId,
  type ToolchainLock,
} from "../../shared/toolchain.ts";
import { COMPONENT_LAYOUT, type InstalledComponent, locateComponents } from "../../substrate/toolchain-store/locate.ts";
import type { RustTargetBuilder, RustTargetSettings } from "../rust-build.ts";
import { type LinuxToolchainLocated, linuxTargetSettings, RUST_LINUX_BUILDER } from "../rust-build-linux.ts";
import { RUST_WINDOWS_BUILDER, windowsTargetSettings } from "../rust-build-windows.ts";

export { rustCrossPinned } from "../../shared/toolchain.ts";

/** The Rust lane's cross destinations and the builder each registers. */
const CROSS_BUILDERS = {
  [BuildTarget.Windows]: RUST_WINDOWS_BUILDER,
  [BuildTarget.Linux]: RUST_LINUX_BUILDER,
} as const satisfies Record<CrossBuildTarget, RustTargetBuilder>;

const CROSS_DESTINATIONS = [BuildTarget.Windows, BuildTarget.Linux] as const;

/** cargo-zigbuild's executable at its component's root, per the host it was installed for. */
const CARGO_ZIGBUILD = {
  [ToolchainHost.MacArm64]: "cargo-zigbuild",
  [ToolchainHost.LinuxX64]: "cargo-zigbuild",
  [ToolchainHost.WindowsX64]: "cargo-zigbuild.exe",
} as const satisfies Record<ToolchainHost, string>;

/** A destination's settings hook, as the lane calls it. */
export type RustSettingsHook = (
  target: BuildTarget,
  build: { bin: string; lock: ToolchainLock },
) => Promise<RustTargetSettings | null>;

/** The Windows and Linux builders whose components the recipe pins; the others stay the lane's refusing placeholders. */
export function rustCrossBuilders(
  required: StackComponents = STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu],
): Partial<Record<BuildTarget, RustTargetBuilder>> {
  const builders: Partial<Record<BuildTarget, RustTargetBuilder>> = {};
  for (const target of CROSS_DESTINATIONS)
    if (rustCrossPinned(target, required)) builders[target] = CROSS_BUILDERS[target];
  return builders;
}

/** The installed components of `ids` the lock pins in `store`; one missing (or a store that is not there) is absent. */
async function installed(
  store: string,
  lock: ToolchainLock,
  ids: readonly ToolchainId[],
): Promise<Map<ToolchainId, InstalledComponent>> {
  const root = await realpath(store).catch(() => null);
  if (root === null) return new Map();
  const found = new Map<ToolchainId, InstalledComponent>();
  for (const id of ids) {
    const one = await locateComponents(root, lock, [id]);
    const component = one.ok ? one.components.get(id) : undefined;
    if (component) found.set(id, component);
  }
  return found;
}

const hostOf = (component: InstalledComponent): ToolchainHost => component.receipt.host ?? ToolchainHost.MacArm64;

/** `rel` under `component`'s folder, realpath'd, or null when it is not there. */
async function inside(component: InstalledComponent | undefined, rel: string): Promise<string | null> {
  if (!component) return null;
  return realpath(path.join(component.folder, ...rel.split("/"))).catch(() => null);
}

/** The store's llvm-mingw root (`bin/clang` beneath it) for `lock`, or null when the lock pins none or it is not installed. */
export async function storeLlvmMingw(store: string, lock: ToolchainLock): Promise<string | null> {
  const found = await installed(store, lock, [ToolchainId.LlvmMingw]);
  return inside(found.get(ToolchainId.LlvmMingw), ".");
}

/** The store's zig, cargo-zigbuild and Linux sysroot for `lock`; each one it does not hold is null. */
export async function storeLinuxToolchain(store: string, lock: ToolchainLock): Promise<LinuxToolchainLocated> {
  const ids = [ToolchainId.Zig, ToolchainId.CargoZigbuild, ToolchainId.LinuxSysroot];
  const found = await installed(store, lock, ids);
  const zig = found.get(ToolchainId.Zig);
  const front = found.get(ToolchainId.CargoZigbuild);
  return {
    zig: zig ? await inside(zig, COMPONENT_LAYOUT.zig[hostOf(zig)]) : null,
    cargoZigbuild: front ? await inside(front, CARGO_ZIGBUILD[hostOf(front)]) : null,
    sysroot: await inside(found.get(ToolchainId.LinuxSysroot), "."),
  };
}

/**
 * The lane's settings hook: the phones' (`mobile`), then Windows' and Linux's over the store at
 * `store` for the build's own lock. Each answers null for a destination not its own, so the first
 * answer is the destination's; a destination nobody answers builds on the lane's own settings.
 */
export function rustTargetSettings(options: {
  store: string;
  mobile: (target: BuildTarget) => Promise<RustTargetSettings | null>;
}): RustSettingsHook {
  const { store, mobile } = options;
  return async (target, build) => {
    if (target === BuildTarget.Windows)
      return windowsTargetSettings(() => storeLlvmMingw(store, build.lock))(target, build);
    if (target === BuildTarget.Linux)
      return linuxTargetSettings(() => storeLinuxToolchain(store, build.lock))(target, build);
    return mobile(target);
  };
}
