/**
 * The Linux destination of the Rust build lane (M4.2): `x86_64-unknown-linux-gnu` for glibc 2.28,
 * cross-built from a Mac or the Linux Studio by cargo-zigbuild with the store's zig 0.16 as the
 * linker (`cross-targets.ts` `RUST_CROSS_TARGETS` and `rustCrossEnv`; never an Apple target).
 *
 * - cpal links libasound (alsa-sys) and gilrs-core libudev (libudev-sys), each found through
 *   pkg-config: the target-scoped pkg-config variables point at the Linux sysroot's link stubs and
 *   `.pc` files and at the pkg-config it carries (`scripts/toolchains/linux-sysroot.ts`), so a host
 *   build script never sees them and the host's own `.pc` folders are never searched.
 * - Clippy and the build run through cargo-zigbuild (the lane's `front`) with the glibc-versioned
 *   target `x86_64-unknown-linux-gnu.2.28`; the lock stays cargo's own. zig's and cargo-zigbuild's
 *   caches live in the build folder, never the person's home.
 * - The link writes a `DT_RUNPATH` of exactly `$ORIGIN` ({@link RUST_LINUX_LINK_FLAGS}): wgpu
 *   opens the Vulkan loader with `dlopen`, which searches the executable's RUNPATH, so an export's
 *   bundled loader and SwiftShader beside the game are found ({@link admitRustLinuxExport} refuses
 *   an export binary without it). The lane's own admission (`admitRustLinuxElf`) is unchanged.
 *
 * The core registers {@link RUST_LINUX_BUILDER} over the lane's `RUST_TARGET_BUILDERS` once the
 * Rust recipe pins the Linux cross components, and chains {@link linuxTargetSettings} with the
 * phones' and Windows' settings over the store at the build's lock (`core/rust-cross-lane.ts`). Nothing here runs the game: the CI floor rows on SwiftShader are M4.4's, and a
 * Linux export says it was never run on a real GPU (`GpuQualification.Untested`).
 */
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import { BuildTarget, GameStack } from "../shared/game-project.ts";
import { STACK_CROSS_EXECUTABLES } from "../shared/native-contract.ts";
import { admitRustLinuxElf, type RustElfAdmission } from "../substrate/native-gate-elf.ts";
import { CrossTarget, RUST_CROSS_TARGETS, rustCrossEnv } from "../substrate/toolchain-store/cross-targets.ts";
import type { RustTargetBuilder, RustTargetSettings } from "./rust-build.ts";

/** Why a Linux build has no settings. Wire values: the lane's refusal lines name them. */
export const LinuxSettingsRefusal = {
  /** The store located no zig for cargo-zigbuild. */
  ZigMissing: "zig-missing",
  /** The store located no cargo-zigbuild. */
  CargoZigbuildMissing: "cargo-zigbuild-missing",
  /** The store located no Linux sysroot (link stubs, `.pc` files, pkg-config). */
  SysrootMissing: "sysroot-missing",
  /** A located path no variable may carry (relative, or holding `:` or a control character), or a store that could not be read. */
  ToolchainUnusable: "linux-toolchain-unusable",
} as const;
export type LinuxSettingsRefusal = (typeof LinuxSettingsRefusal)[keyof typeof LinuxSettingsRefusal];

const MESSAGE = {
  ZigMissing: "no zig: the store's Linux linker is not installed",
  CargoZigbuildMissing: "no cargo-zigbuild: the store's Linux build front end is not installed",
  SysrootMissing: "no Linux sysroot: the store's link stubs and pkg-config files are not installed",
  Unusable: (detail: string) => `the store's Linux toolchain cannot be used: ${detail}`,
  BadPath: (value: string) => `${JSON.stringify(value)} is not an absolute path a build may run`,
} as const;

/** The Linux cross spec: its triple, cargo-zigbuild's target and the runtime files an export ships. */
const SPEC = RUST_CROSS_TARGETS[CrossTarget.LinuxX64];
/** cargo-zigbuild's subcommands for the lane's two steps. */
const FRONT_SUBCOMMANDS = { clippy: "clippy", build: "zigbuild" } as const;
/** The build folder's subfolder zig's and cargo-zigbuild's caches go in. */
const CROSS_CACHE_FOLDER = "cross";
/** Where the sysroot keeps the pkg-config a host without one runs. */
const SYSROOT_PKG_CONFIG = ["bin", "pkg-config"] as const;
/** `:` splits search paths; a control character ends a value. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const UNUSABLE_PATH = /[:\x00-\x1f\x7f]/;

/**
 * The link arguments every Linux build carries: new dtags, so the search path is a `DT_RUNPATH`
 * (never a `DT_RPATH`), of exactly `$ORIGIN`. `$ORIGIN` reaches the linker literally: every word
 * of a lane command is shell-quoted.
 */
export const RUST_LINUX_LINK_FLAGS: readonly string[] = Object.freeze([
  "-C",
  "link-arg=-Wl,--enable-new-dtags",
  "-C",
  "link-arg=-Wl,-rpath,$ORIGIN",
]);

/**
 * The lane's Linux builder: one `game` (windowed or headless by how the host starts it; a dev
 * build also serves the studio over fd 3) and the staged assets beside it. `macSdk` is false: zig
 * brings glibc 2.28's own stubs and headers.
 */
export const RUST_LINUX_BUILDER = {
  ready: true,
  triple: SPEC.rustTriple,
  macSdk: false,
  executables: [STACK_CROSS_EXECUTABLES[GameStack.RustWgpu][BuildTarget.Linux]],
  assets: true,
} as const satisfies RustTargetBuilder;

/** What the store located for a Linux build; null for a component it does not have. */
export interface LinuxToolchainLocated {
  /** zig's executable (its `lib/` folder beside it). */
  zig: string | null;
  /** cargo-zigbuild's executable. */
  cargoZigbuild: string | null;
  /** The Linux sysroot's root (`usr/lib64` stubs and `.pc` files, `bin/pkg-config`). */
  sysroot: string | null;
}

/** What was found for one Linux build: the store's tools and the build folder its caches live in. */
export interface LinuxToolchainFound extends LinuxToolchainLocated {
  bin: string;
}

const refused = (code: LinuxSettingsRefusal, detail: string): RustTargetSettings => ({ ok: false, code, detail });

/** Why a located path cannot be handed to a build, or null when it can. */
function unusable(value: string): string | null {
  return path.posix.isAbsolute(value) && !UNUSABLE_PATH.test(value) ? null : MESSAGE.BadPath(value);
}

/**
 * The environment, rustflags, sandbox reads and front end a Linux build needs, or why it cannot be
 * made: pkg-config over the sysroot for the target only, zig for cargo-zigbuild with both caches in
 * the build folder, the `$ORIGIN` link, and cargo-zigbuild for clippy and the build. A missing
 * tool, or one at a path that is relative or holds `:` or a control character, is refused with no
 * setting at all.
 */
export function linuxBuildSettings(found: LinuxToolchainFound): RustTargetSettings {
  const { zig, cargoZigbuild, sysroot } = found;
  if (!zig) return refused(LinuxSettingsRefusal.ZigMissing, MESSAGE.ZigMissing);
  if (!cargoZigbuild) return refused(LinuxSettingsRefusal.CargoZigbuildMissing, MESSAGE.CargoZigbuildMissing);
  if (!sysroot) return refused(LinuxSettingsRefusal.SysrootMissing, MESSAGE.SysrootMissing);
  const bad = [zig, cargoZigbuild, sysroot, found.bin].map(unusable).find((problem) => problem !== null);
  if (bad) return refused(LinuxSettingsRefusal.ToolchainUnusable, MESSAGE.Unusable(bad));
  try {
    const env = rustCrossEnv(CrossTarget.LinuxX64, {
      folder: path.posix.join(found.bin, CROSS_CACHE_FOLDER),
      zig,
      sysroot,
      pkgConfig: path.posix.join(sysroot, ...SYSROOT_PKG_CONFIG),
    });
    return {
      ok: true,
      env,
      rustflags: [...SPEC.rustflags, ...RUST_LINUX_LINK_FLAGS],
      reads: [path.posix.dirname(zig), path.posix.dirname(cargoZigbuild), sysroot],
      front: { program: cargoZigbuild, ...FRONT_SUBCOMMANDS, target: SPEC.cargoTarget },
    };
  } catch (error) {
    return refused(LinuxSettingsRefusal.ToolchainUnusable, MESSAGE.Unusable(errorMessage(error)));
  }
}

/** Where the store's zig, cargo-zigbuild and Linux sysroot for the lane's lock are. */
export type LocateLinuxToolchain = () => Promise<LinuxToolchainLocated>;

/**
 * The lane's `targetSettings` for Linux: {@link linuxBuildSettings} over what the store located,
 * per build folder; null for every other destination (the core chains it with the phones' and
 * Windows' settings, `rustTargetSettings`). A store that cannot be read is refused `linux-toolchain-unusable`.
 */
export function linuxTargetSettings(
  locate: LocateLinuxToolchain,
): (target: BuildTarget, build: { bin: string }) => Promise<RustTargetSettings | null> {
  return async (target, build) => {
    if (target !== BuildTarget.Linux) return null;
    try {
      return linuxBuildSettings({ ...(await locate()), bin: build.bin });
    } catch (error) {
      return refused(LinuxSettingsRefusal.ToolchainUnusable, MESSAGE.Unusable(errorMessage(error)));
    }
  };
}

/**
 * Admits a Rust · wgpu game's Linux executable for an export: the lane's Linux policy
 * (`admitRustLinuxElf`: x86_64, glibc's loader, glibc ≤ 2.28, only glibc, libgcc_s, libasound and
 * libudev, no GL, no `DT_RPATH`) with a `DT_RUNPATH` of exactly `$ORIGIN`, which the bundled
 * Vulkan loader and SwiftShader beside it need. Pure; never throws.
 */
export function admitRustLinuxExport(bytes: Uint8Array): RustElfAdmission {
  return admitRustLinuxElf(bytes, { requireOrigin: true });
}
