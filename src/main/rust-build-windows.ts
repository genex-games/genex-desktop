/**
 * The Windows destination of the Rust build lane (M4.1): `x86_64-pc-windows-gnullvm`, cross-built
 * from a Mac or the Linux Studio by cargo with llvm-mingw's clang as the linker and the `cc`
 * crate's compiler (`cross-targets.ts` `RUST_CROSS_TARGETS` and `rustCrossEnv`).
 *
 * - The C runtime is static (`+crt-static`), so LLVM's libunwind links in and nothing ships beside
 *   `game.exe`; the CRT stays the system UCRT through the API sets.
 * - The link carries no timestamp (`--no-insert-timestamp`): two builds of the same sources in the
 *   same folder give the same bytes, so the export's `.zip` is byte-identical too.
 * - The executable draws through wgpu on D3D12 alone, with FXC (`d3dcompiler_47.dll`) chosen
 *   explicitly in the instance descriptor (`genex-render`'s `gpu.rs`, never `from_env`); no
 *   Vulkan or GL backend is requested on Windows (`floor.rs`). wgpu loads `d3dcompiler_47.dll`,
 *   `d3d12.dll` and `dxgi.dll` by bare name, so Windows' default search order (the executable's
 *   folder first) finds them: the run bundle and the export must never put a DLL beside
 *   `game.exe`. A machine without a
 *   WebGPU-compliant D3D12 adapter gets the facade's typed `gpu-unsupported` exit. The PE policy
 *   (`native-gate-pe.ts` `admitRustPe`) refuses an executable importing desktop OpenGL or a DXC
 *   compiler, through the lane's admission of every `out/`.
 *
 * The core registers {@link RUST_WINDOWS_BUILDER} over the lane's `RUST_TARGET_BUILDERS` once the
 * Rust recipe pins the Windows cross components (`core/rust-cross-lane.ts`) and hands the lane
 * {@link windowsTargetSettings} beside the phones' settings, which the lane merges into a Windows
 * build's environment, rustflags and sandbox reads. Nothing here runs the game: the D3D12-under-WARP
 * row is CI's (M4.4), and every Windows export says it was not run on a real GPU
 * (`GpuQualification.Untested`) until a real machine runs one.
 */
import { errorMessage } from "../shared/errors.ts";
import { BuildTarget, GameStack } from "../shared/game-project.ts";
import { STACK_CROSS_EXECUTABLES } from "../shared/native-contract.ts";
import { CrossTarget, RUST_CROSS_TARGETS, rustCrossEnv } from "../substrate/toolchain-store/cross-targets.ts";
import type { RustTargetBuilder, RustTargetSettings } from "./rust-build.ts";

/** Why a Windows build has no settings. Wire values: the lane's refusal lines name them. */
export const WindowsSettingsRefusal = {
  /** The store located no llvm-mingw, or one at a path no variable may carry. */
  LlvmMingwMissing: "llvm-mingw-missing",
} as const;
export type WindowsSettingsRefusal = (typeof WindowsSettingsRefusal)[keyof typeof WindowsSettingsRefusal];

const MESSAGE = {
  LlvmMingwMissing: "no llvm-mingw: the store's Windows linker is not installed",
  LlvmMingwUnusable: (detail: string) => `the store's llvm-mingw cannot be used: ${detail}`,
} as const;

/** The Windows cross spec: its triple, linker and rustflags. */
const SPEC = RUST_CROSS_TARGETS[CrossTarget.WindowsX64];

/** The link without a timestamp: lld's MinGW driver otherwise stamps the PE header with the time of the link. */
const REPRODUCIBLE_LINK = ["-C", "link-arg=-Wl,--no-insert-timestamp"] as const;

/**
 * The lane's Windows builder: one `game.exe` (windowed; a dev build also serves the studio over
 * its named pipe) and the staged assets beside it. `macSdk` is false: llvm-mingw brings its own
 * Windows headers and import libraries.
 */
export const RUST_WINDOWS_BUILDER = {
  ready: true,
  triple: SPEC.rustTriple,
  macSdk: false,
  executables: [STACK_CROSS_EXECUTABLES[GameStack.RustWgpu][BuildTarget.Windows]],
  assets: true,
} as const satisfies RustTargetBuilder;

/** What was found for a Windows build: the store's llvm-mingw root (`bin/` holds its clang and llvm-ar). */
export interface WindowsToolchainFound {
  llvmMingw: string | null;
  /** The build folder: the cross environment's caches go inside it, never the person's home. */
  bin: string;
}

/**
 * The environment, rustflags and sandbox reads a Windows build needs, or why it cannot be made:
 * llvm-mingw's clang as cargo's linker and the `cc` crate's compilers (scoped to the triple, so a
 * host build script never sees them), the static C runtime and the timestamp-free link. A missing
 * llvm-mingw, or one at a path that is relative or holds `:` or a control character, is refused
 * `llvm-mingw-missing` with no setting at all.
 */
export function windowsBuildSettings(found: WindowsToolchainFound): RustTargetSettings {
  if (found.llvmMingw === null || found.llvmMingw === "") {
    return { ok: false, code: WindowsSettingsRefusal.LlvmMingwMissing, detail: MESSAGE.LlvmMingwMissing };
  }
  try {
    const env = rustCrossEnv(CrossTarget.WindowsX64, { folder: found.bin, llvmMingw: found.llvmMingw });
    return { ok: true, env, rustflags: [...SPEC.rustflags, ...REPRODUCIBLE_LINK], reads: [found.llvmMingw] };
  } catch (error) {
    const detail = MESSAGE.LlvmMingwUnusable(errorMessage(error));
    return { ok: false, code: WindowsSettingsRefusal.LlvmMingwMissing, detail };
  }
}

/** Where the store's llvm-mingw for the lane's lock is, or null when it is not installed. */
export type LocateLlvmMingw = () => Promise<string | null>;

/**
 * The lane's `targetSettings` for Windows: {@link windowsBuildSettings} over the store's
 * llvm-mingw; null for every other destination (the core chains it with the phones' and Linux's
 * settings, `rustTargetSettings`).
 */
export function windowsTargetSettings(
  locate: LocateLlvmMingw,
): (target: BuildTarget, build: { bin: string }) => Promise<RustTargetSettings | null> {
  return async (target, build) => {
    if (target !== BuildTarget.Windows) return null;
    const llvmMingw = await locate().catch(() => null);
    return windowsBuildSettings({ llvmMingw, bin: build.bin });
  };
}
