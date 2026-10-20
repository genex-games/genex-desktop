/**
 * The Rust build lane (`RustBuilds`): a Rust · wgpu game built per destination and toolchain lock,
 * behind the build-lane seam (`game-build.ts`), into `<root>/<project>-<sha12(realroot)>/<target>-<lockDigest12>/`.
 *
 * Every build runs in a sandbox of its own (`rustBuildSandboxes`), never the agents' one: it writes
 * only its build folder (the target folder and a private `TMPDIR` inside it), reads the store, the
 * staged copy and the system, and opens no domain. Its commands start from an empty environment
 * (`env -i`), so the proxy settings sandbox-runtime hands every sandboxed process (and with them
 * the registry a package install opened, process-wide) never reach cargo or a build script.
 *
 * What cargo reads is the host's alone. The game's sources are staged beside the build folder
 * (`<bin>.stage`, M2.2's link-free copy with a host-written `Cargo.toml`); `CARGO_HOME` is a
 * host-written folder beside it (`<bin>.cargo`) and `HOME` an empty one (`<bin>.home`); cargo runs
 * from `/`, so no `.cargo/config.toml` in the game, the folders above it or the person's home is
 * on its discovery path; the security settings are `--config` overrides on every command. The lock
 * is generated offline against the vendored registry in the build folder, read back and verified
 * (every package the vendored registry's or a path package), then copied into the stage for
 * `--offline --locked` runs: clippy with the store's `clippy.toml` and `-D warnings` first, then the
 * build, both under `RUSTFLAGS=-F unsafe_code`.
 *
 * The game's trust flag (`rust-trust.ts`, set only by the person) is the one way off that policy
 * (`rustTrustPolicy`): with it on, `-F unsafe_code` is dropped and the game's own `build.rs`
 * (staged here) builds. An ejected engine's crates always build from the store's manifests
 * (`rust-stage.ts`), so their build scripts and proc macros stay off even then: trust covers the
 * game's own crates, never the engine fork's manifests, which stay the host's. With
 * it off any build script, the engine's included, refuses the build `build-script-refused` before
 * cargo runs and an `unsafe` error is reported `unsafe-code`. The build's sandbox is the same
 * either way.
 *
 * Cargo's JSON messages decide everything read back: the first diagnostic with spans, and the
 * executable a build produced (never a path guessed from the target folder's layout). The
 * executable and the staged assets are copied into `<bin>.out`, outside every build-writable path,
 * and their digests recorded in `<bin>.admitted`: a process a build left behind cannot reach them,
 * and an output that no longer matches its digests is no output. A receipt (`<bin>.receipt.json`)
 * records each step's time and the compiler's identity.
 *
 * An export keeps its debug files beside `<bin>.out`, never in it (CRASH-7a,
 * `substrate/rust-debug-files.ts`): its release profile carries line tables, and after admission
 * the dSYM (Apple), the unstripped executable (ELF and PE, whose shipped copy the toolchain's
 * `llvm-objcopy --strip-debug` wrote in the build's sandbox) or the web export's wasm-opt symbol
 * map go to `<bin>.debug/<digest>/`, keyed by the shipped file's SHA-256. Keeping them never fails
 * a build.
 *
 * Destinations are built by {@link RUST_TARGET_BUILDERS}: the Mac's here, and refusing
 * placeholders for the others until their lanes land in their own modules (web M2.9, iOS and
 * Android M2.10, Windows M4.1 `rust-build-windows.ts`, Linux M4.2 `rust-build-linux.ts` through cargo-zigbuild, a `front`), each registered over this table by its slice
 * integrator (`rustTargetBuilders` in `core/internals.ts`). A web build is packaged after cargo
 * (`packageWeb` in `rust-build-web.ts`: wasm-bindgen, wasm-opt for an export, the app's own shell
 * titled for the game) in the same sandbox, and `out/` serves that folder; a phone build takes
 * its destination's settings (`targetSettings`, `rust-build-mobile.ts`) over the lane's own.
 *
 * The facade's flavour follows the purpose: Live and judging builds of a desktop game link the
 * dev flavour (the `studio` feature, so the game serves fd 3); an export and every web build
 * never link genex-studio (`RustFlavour`, `rust-manifest.ts`).
 */
import type { LoadingStyle } from "../shared/loading-style.ts";
import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";
import { BuildPhase, type BuildProblem, BuildProblemCode, CppBuildPurpose } from "../shared/build-problem.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";
import { BuildTarget, GameStack } from "../shared/game-project.ts";
import { hostOf, STACK_HOST_MATRIX } from "../shared/game-targets.ts";
import type { ToolchainLock } from "../shared/toolchain.ts";
import type { UiEventMap } from "../shared/ui-events.ts";
import { atomicWriteText, openNoFollow, readRegularFile } from "../substrate/fsx.ts";
import { type AssetGroupRow, type AssetsToml, assetBudgetOf } from "../substrate/genex-toml.ts";
import { isInside, toPosixRelative } from "../substrate/paths.ts";
import { literalGlob, ProcessSandbox, type RunRequest, type RunResult, shellQuote } from "../substrate/spawn.ts";
import type { CrateRefusal } from "../shared/crate-requests.ts";
import { mergedVendor } from "../substrate/toolchain-store/crate-overlay.ts";
import type { CrateId } from "../substrate/toolchain-store/crate-vendor-job.ts";
import { execXcode, macSdkPath, type XcodeExec } from "../substrate/toolchain-store/locate.ts";
import { isLockDigest } from "../substrate/toolchain-store/lock.ts";
import { RUST_DEV_PROFILE_SETTINGS } from "../substrate/toolchain-store/rust-locate.ts";
import {
  type DebugSource,
  DebugFileKind,
  debugFileKind,
  EXPORT_DEBUG_SETTINGS,
  keepDebugFiles,
  rustObjcopy,
  stripDebugCommand,
  WEB_SYMBOL_MAP_FILE,
} from "../substrate/rust-debug-files.ts";
import { refusalProblem, toolchainRefusal } from "./cpp-build.ts";
import {
  packageWeb,
  RUST_WEB_EXPORT_PROFILE_SETTINGS,
  RUST_WEB_STEP_TIMEOUT_MS,
  WEB_FILES,
  type WebReceipt,
  type WebTools,
  writeWebAssetMap,
} from "./rust-build-web.ts";
import type { RustStageImport, StagedImportReport } from "./rust-assets.ts";
import { colyseusBuildEnv } from "./rust-colyseus.ts";
import {
  type AssetPackageReport,
  PackageRefusal,
  packageAssets,
  packageCeilingRefusal,
  reservedAssetName,
} from "./rust-package-assets.ts";
import { AssetLockState, readAssetLock } from "./asset-db.ts";
import type { AssetLockEntry } from "../shared/asset-db.ts";
import { RUST_ENGINE_FOLDER, RustFlavour } from "./rust-manifest.ts";
import { type GameTrust, ownBuildScripts, UNTRUSTED } from "./rust-trust.ts";
import { ExtensionRefusal } from "../shared/game-conformance.ts";
import type { RustOutputAdmission } from "../substrate/native-cross-admission.ts";
import type { BuildOutcome, GameBuildGame, GameBuildLane, GameBuildOptions } from "./game-build.ts";
import {
  type CargoMessages,
  diagnosticLines,
  parseCargoMessages,
  parseRustcIdentity,
  RustBuildRefusal,
  type RustBuildReceipt,
  RustBuildStep,
  type RustCompilerIdentity,
  type RustAdmissionRefusal,
  type RustCrateRefusal,
  type RustLaneReport,
} from "./rust-build-diagnostics.ts";

const MESSAGE = {
  notAllowed: (names: readonly string[]) =>
    `the game asks for ${names.join(", ")}, which ${names.length === 1 ? "is" : "are"} not on the reviewed crate list`,
  lockSource: (name: string, source: string) => `${name} would come from ${source}, not the vendored crates`,
  lockVendor: (name: string, version: string) => `${name} ${version} is not in the vendored crates`,
  lockUnreadable: "cargo wrote no lock the lane could read",
  targetUnbuilt: (target: string) => `Rust games do not build for ${target} in this version yet`,
  noArtifact: "the build finished, but cargo named no executable for the game",
  artifactRefused: (file: string) => `${file} is not a file the build wrote in its own folder`,
  stripFailed: (file: string, code: number | null) =>
    `llvm-objcopy could not strip the debug lines from ${file} (exit ${code ?? "on a signal"}), so the export ships nothing`,
  linked: (where: string) => `${where} is a link or not a folder, and the build lane never works through one`,
  webShellMissing: "the app's web shell (game-template-rust/web/shell.html) is not a page the app ships",
  webToolsMissing: "the store located no wasm-bindgen for the web build",
  webRefused: (code: string, detail: string) => `${code}: ${detail}`,
  settingsRefused: (code: string, detail: string) => `${code}: ${detail}`,
  crateRefused: (code: string, detail: string) => `${code}: ${detail}`,
  admissionRefused: (file: string, refusal: string, detail: string) => `${file}: ${refusal}: ${detail}`,
  buildScripts: (files: readonly string[]) =>
    `${ExtensionRefusal.BuildScriptRefused}: ${files.join(", ")} would run at build time, and only a game the person trusts may`,
  unsafeCode: `${ExtensionRefusal.UnsafeCode}: \`unsafe\` code builds only in a game the person trusts`,
  trustClaimed: `${ExtensionRefusal.TrustPersonOnly}: the game's own files cannot trust it; only the person can, in Studio`,
  buildScriptLinked: (file: string) => `${file} is a link or not a file, and the build lane never works through one`,
  stoppedBySignal: (signal: string) =>
    `the build stopped on ${signal} before it printed anything (the system ends a build this way when memory or disk runs out)`,
} as const;

/** How long a whole `cargo build` (or clippy) may run, per destination. */
export const RUST_BUILD_TIMEOUT_MS = {
  [BuildTarget.Web]: 15 * MINUTE_MS,
  [BuildTarget.Mac]: 15 * MINUTE_MS,
  [BuildTarget.Windows]: 15 * MINUTE_MS,
  [BuildTarget.Linux]: 15 * MINUTE_MS,
  [BuildTarget.Ios]: 20 * MINUTE_MS,
  [BuildTarget.Android]: 20 * MINUTE_MS,
} as const satisfies Record<BuildTarget, number>;
/** How long `cargo generate-lockfile --offline` may run. */
const LOCK_TIMEOUT_MS = 2 * MINUTE_MS;
/** How long `rustc -vV` may run. */
const IDENTITY_TIMEOUT_MS = 30 * SECOND_MS;
/** How long an export's `llvm-objcopy --strip-debug` may run. */
const STRIP_TIMEOUT_MS = 2 * MINUTE_MS;
/** How many cores one build gets before a second may run beside it. */
const CORES_PER_BUILD = 4;
/** How much of a build's output the sandbox keeps: a cold build prints a JSON line per crate. */
const OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
/** The most of a Cargo.lock the host reads back. */
const LOCK_MAX_BYTES = 4 * 1024 * 1024;
/** The most of a stamp or an admitted manifest the host reads. */
const STAMP_MAX_BYTES = 1024 * 1024;
/** The biggest executable the lane admits. */
const EXECUTABLE_MAX_BYTES = 1024 * 1024 * 1024;
/** How many output lines a problem keeps when cargo printed no diagnostic. */
const PROBLEM_LINES = 6;
/** cargo's own failure line. */
const CARGO_ERROR = /^error(\[[A-Z0-9]+\])?:/;
/** cargo's progress lines: never the reason a step failed. */
const CARGO_PROGRESS =
  /^\s+(Compiling|Checking|Fresh|Finished|Blocking|Locking|Adding|Updating|Building|Running|Dirty|Waiting)\b/;

/**
 * The crates a game may name besides the facade: the facade's re-exports cover the rest. Adding
 * one is a release change (plan "Agent policy"); a game gets any other crate only through the
 * person-approved request flow (M3.15). Name → the reviewed version line.
 */
export const RUST_CRATE_ALLOWLIST = { noise: "0.9", fastrand: "2.5" } as const satisfies Record<string, string>;
/** The variable the facade reads at compile time for the native-enhanced features a game declares. */
const NATIVE_FEATURES_ENV = "GENEX_NATIVE_FEATURES";
/** The variable the facade reads at compile time for the game's `[render]` tables (`genex::render`). */
const RENDER_TOML_ENV = "GENEX_RENDER_TOML";
/** The variable the facade reads at compile time for the game's `[[wgsl]]` rows (`genex::extend`). */
const WGSL_TOML_ENV = "GENEX_WGSL_TOML";
/** The facade every game depends on. */
const FACADE_CRATE = "genex";
/** The vendored registry's name in the host's source replacement. */
const VENDORED_SOURCE = "genex-vendored";
/** How a vendored package appears in a lock: crates.io, replaced by the vendored directory. */
const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
/** The unsafe-code policy every game crate is compiled under (M7.2's trust flag is the only way off it). */
const GAME_RUSTFLAGS = "-F unsafe_code";
/** The rustc lint an `unsafe` block under {@link GAME_RUSTFLAGS} fails with. */
const UNSAFE_CODE_LINT = "unsafe_code";
/** A game's own build script, beside its `genex.toml`; staged only for a trusted game. */
const BUILD_SCRIPT_FILE = "build.rs";
/** The line the host-written manifest turns build scripts off with (`rust-manifest.ts`), and what a trusted game's says. */
const NO_BUILD_SCRIPT_LINE = /^build = false$/m;
const BUILD_SCRIPT_LINE = `build = "${BUILD_SCRIPT_FILE}"`;
/** The most of a game's build script the host stages. */
const BUILD_SCRIPT_MAX_BYTES = 1024 * 1024;

/** What the game's trust flag changes about a build: never its sandbox. */
export interface RustTrustPolicy {
  /** Rustflags every crate of the build is compiled with, before a destination's own. */
  rustflags: readonly string[];
  /** Whether the game's own `build.rs` may build (an ejected engine's never does: it builds from the store's manifests). */
  buildScripts: boolean;
}

/** The policy a game builds under: `-F unsafe_code` and no build scripts, unless the person trusts it. */
export function rustTrustPolicy(trusted: boolean): RustTrustPolicy {
  return trusted ? { rustflags: [], buildScripts: true } : { rustflags: [GAME_RUSTFLAGS], buildScripts: false };
}

/** Folders and files of one build, beside or inside its build folder `<bin>`. */
const STAGE_SUFFIX = ".stage";
const CARGO_HOME_SUFFIX = ".cargo";
const HOME_SUFFIX = ".home";
const OUT_SUFFIX = ".out";
const ADMITTED_SUFFIX = ".admitted";
const RECEIPT_SUFFIX = ".receipt.json";
const SOURCE_SUFFIX = ".source";
/** Beside the build folder: the host-written directory source of the store's crates and the game's granted overlay crates. */
const VENDOR_SUFFIX = ".vendor";
const TARGET_DIR = "target";
const TMP_DIR = "tmp";
const LOCK_DIR = "lock";
const MANIFEST_FILE = "Cargo.toml";
const LOCK_FILE = "Cargo.lock";
const ASSETS_DIR = "assets";
/** Inside the build folder: the web branch's packaged folder, which `out/` serves. */
const WEB_DIR = "web";
/** Inside the build folder: an export's stripped executable and web symbol map, before admission keeps them (CRASH-7a). */
const DEBUG_STAGE_DIR = "debug";
/** The stub entry the lock is generated against: resolution reads only the manifest. */
const LOCK_STUB_MAIN = "fn main() {}\n";
/** The working folder every cargo command runs from: no `.cargo/config.toml` can be planted above it. */
const CARGO_CWD = "/";
/** The system's own tools, after the toolchain's. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** The program every command starts through, with an empty environment. */
const ENV = "/usr/bin/env";
/** A build folder of one project: `<project>-<sha12>`. */
const PROJECT_FOLDER = /^(.+)-[0-9a-f]{12}$/;
/** One destination's build folder for one lock: `<target>-<digest12>`. */
const BUILD_FOLDER = /^([a-z]+)-([0-9a-f]{12})$/;
/** A project name that is one plain path segment; any other is foldered as {@link UNNAMED_PROJECT}. */
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UNNAMED_PROJECT = "game";
/** cargo's build profile per purpose: an export ships an optimized build. */
const PROFILE = { dev: "dev", release: "release" } as const;

/** Where the Rust toolchain a lock names is installed, as the store locates it (M2.3). */
export interface RustToolchain {
  /** The sysroot's `bin` folder: cargo, rustc, cargo-clippy and clippy-driver. */
  bin: string;
  /** The vendored crate tree, the only registry cargo resolves from. */
  vendor: string;
  /** The folder holding the store's `clippy.toml` (`CLIPPY_CONF_DIR`). */
  clippyConf: string;
  /** Folders a build may read besides the stage: the sysroot, the vendored crates, the facade's sources. */
  reads: readonly string[];
  /** The web branch's packaging tools (a web build's locate names them); absent for other destinations. */
  web?: WebTools;
  /** The store's `colyseus` component folder (installed or not) a native build names its libcolyseus folder in; absent: none pinned here. */
  colyseus?: string;
}

/**
 * What a game may use of its profile's crate overlay (extension ladder level 4,
 * `main/crate-requests.ts`): the overlay crates granted to it (linked into the build's directory
 * source), every crate name the person approved for it, and the typed refusal of each crate a
 * decision refused; or why the overlay may not be read at all (`crate-overlay-tampered`).
 */
export type RustCrateGrant =
  | {
      ok: true;
      /** The overlay's vendor folder; null when nothing of it is granted. */
      vendor: string | null;
      crates: readonly CrateId[];
      names: readonly string[];
      refused: Readonly<Record<string, CrateRefusal>>;
    }
  | { ok: false; refusal: CrateRefusal; detail: string };

/** The grant of a lane with no crate requests: nothing beyond the allowlist. */
const NO_GRANT = { ok: true, vendor: null, crates: [], names: [], refused: {} } as const satisfies RustCrateGrant;

/** What locating a lock's Rust toolchain found. */
export type RustLocateResult =
  | { ok: true; toolchain: RustToolchain }
  | { ok: false; missing: string[]; needsPrewarm?: true; stale?: true; notHosted?: true };

/**
 * What staging a game answered (M2.2): the crates its host-written manifest names and its
 * `genex.toml` title (the web page's), or a typed refusal.
 */
export type RustStaged =
  | {
      ok: true;
      dependencies: readonly string[];
      title?: string;
      /** The native-enhanced features `genex.toml` declares (wire names); absent or empty: core only. */
      nativeFeatures?: readonly string[];
      /** `genex.toml`'s checked `[render]` tables as a fragment (`GENEX_RENDER_TOML`); null or absent: none. */
      renderToml?: string | null;
      /** Its checked `[[wgsl]]` rows as a fragment (`GENEX_WGSL_TOML`, empty for none); absent: not compiled in. */
      wgslToml?: string;
      /** `[web] wasm_budget_mb`, the web export's code budget in MB of gzip; null or absent: the default. */
      wasmBudgetMb?: number | null;
      /** `[render.loading]`, checked: the web page's loading screen; null or absent: the defaults. */
      loading?: LoadingStyle | null;
      /** `[[asset_group]]` rows, checked: the asset index's named groups (C-30); absent: none. */
      assetGroups?: readonly AssetGroupRow[];
      /** `[assets]`, checked: the package's budget and a phone's texture cap (C-17); null or absent: the defaults. */
      assets?: AssetsToml | null;
    }
  | { ok: false; code: string; detail: string };

/**
 * Stages `game`'s sources link-free into `into` for `target` and writes its `Cargo.toml` from
 * `genex.toml` (M2.2: `stageRustGame` in `rust-stage.ts`, whose `manifest.crates` with the facade
 * are the dependencies), linking the facade in `flavour`. `into` is the host's, beside the build
 * folder; any `Cargo.lock` staged there is replaced by the one the lane generates and verifies.
 */
export type RustStage = (
  game: Pick<GameBuildGame, "project" | "dir">,
  into: string,
  target: BuildTarget,
  flavour: RustFlavour,
  /** The toolchain lock the build runs on: its vendored crate set is what the stage may pin; absent, the shipped release. */
  lock?: ToolchainLock,
  /** The store's vendored crate set: an ejected game's forked crates take their `Cargo.toml` from it (M7.1). */
  vendor?: string,
  /** The release the person ejected the game's engine from, as the profile records it; null or absent: not ejected. */
  ejectedFrom?: string | null,
) => Promise<RustStaged>;

/**
 * A destination's settings over the lane's own (a phone build's SDK or NDK, `rust-build-mobile.ts`):
 * variables set over the build environment, rustflags appended, folders the sandbox reads; or why
 * this host cannot make it. Null: the destination needs none.
 */
export type RustTargetSettings =
  | {
      ok: true;
      env: Readonly<Record<string, string>>;
      rustflags: readonly string[];
      reads: readonly string[];
      /** The front end clippy and the build run through instead of cargo (Linux's cargo-zigbuild); absent: cargo. */
      front?: RustCargoFront;
    }
  | { ok: false; code: string; detail: string };

/**
 * A cargo front end (cargo-zigbuild for a glibc-versioned Linux build, `rust-build-linux.ts`):
 * clippy and the build run as `<program> <subcommand> …` with the lane's own arguments and
 * environment, `--target` set to `target`; the lock is still cargo's own.
 */
export interface RustCargoFront {
  /** The front end's executable: absolute, the store's. */
  program: string;
  /** Its subcommand for the clippy gate. */
  clippy: string;
  /** Its subcommand for the build. */
  build: string;
  /** What `--target` is handed (cargo-zigbuild reads the glibc version after the triple). */
  target: string;
}

/** The one sandbox a build runs in: the folders it may write and read, and no domain. */
export interface RustBuildSandboxSpec {
  /** The build folder. */
  bin: string;
  /** Its private `TMPDIR`, inside it. */
  tmp: string;
  /** Exactly the build folder. */
  allowWrite: string[];
  /** The build folder, the stage, the host-written `CARGO_HOME` and `HOME`, and the toolchain's folders. */
  reads: string[];
  /** The source root and the paths no build writes (the store, the native runs), as named and as real. */
  denyWrite: string[];
  /** Always empty: a build opens no domain. */
  allowedDomains: string[];
}

/** A build's own sandbox, let go when the build ends. */
export interface RustBuildSandbox {
  run(request: RunRequest): Promise<RunResult>;
  dispose(): Promise<void>;
}

/** A destination's builder: how cargo builds it and how its `out/` is laid out from what cargo produced. */
export type RustTargetBuilder =
  | {
      ready: true;
      /** rustc's target triple. */
      triple: string;
      /** Whether the build needs the Mac SDK (`SDKROOT`, from `xcrun`, outside the sandbox). */
      macSdk: boolean;
      /** The names `out/` holds the game's executable under. */
      executables: readonly string[];
      /** Whether `out/assets` holds the staged assets. */
      assets: boolean;
    }
  | { ready: false };

/** A destination whose builder lives in its own module and registers at its slice's merge. */
const PENDING_BUILDER: RustTargetBuilder = { ready: false };

/**
 * The builder per destination. The Mac's is this lane's: one executable, which runs windowed or
 * headless by how the host starts it, under both of the names a Mac run admits. The others refuse
 * `target-unbuilt` until their modules register (web `rust-build-web.ts` M2.9, iOS and Android
 * M2.10; Windows M4.1 and Linux M4.2 once the Rust recipe pins their cross components,
 * `core/rust-cross-lane.ts`).
 */
export const RUST_TARGET_BUILDERS = {
  [BuildTarget.Mac]: {
    ready: true,
    triple: "aarch64-apple-darwin",
    macSdk: true,
    executables: ["game", "game-headless"],
    assets: true,
  },
  [BuildTarget.Web]: PENDING_BUILDER,
  [BuildTarget.Windows]: PENDING_BUILDER,
  [BuildTarget.Linux]: PENDING_BUILDER,
  [BuildTarget.Ios]: PENDING_BUILDER,
  [BuildTarget.Android]: PENDING_BUILDER,
} as const satisfies Record<BuildTarget, RustTargetBuilder>;

/** Everything the lane reaches, injected. */
export interface RustBuildsOptions {
  /** Where build folders live: the host's own `layout.rustBuilds`, under no writable root. */
  root: string;
  /** A sandbox of its own for each build ({@link rustBuildSandboxes}). */
  sandbox: (spec: RustBuildSandboxSpec) => Promise<RustBuildSandbox>;
  /** The lock's Rust toolchain for a destination (M2.3's store). */
  locate: (lock: ToolchainLock, target: BuildTarget) => Promise<RustLocateResult>;
  /** The store's current Rust lock. */
  currentLock: () => Promise<ToolchainLock | null>;
  /** Stages a game and writes its manifest (M2.2). */
  stage: RustStage;
  emit: (progress: UiEventMap["build.progress"]) => void;
  platform: NodeJS.Platform;
  /** Caps concurrent builds and `build.jobs`. */
  cores: number;
  /** Paths every build denies writes to besides the source root (the store, the native runs). */
  denyWrite: readonly string[];
  /** Records the lock digest a build of the game folder used, in the host's library. */
  writeLock: (project: string, digest: string) => Promise<void>;
  /**
   * The lock digests the library's games recorded (`GameWorkspaces.nativeLocks`): the sweep keeps
   * their build folders, so a game kept on an older Rust lock after an update is not rebuilt from
   * nothing at every start. Absent: none; a failed read keeps every lock's folders.
   */
  retainedLocks?: () => Promise<readonly string[]>;
  /** Builders registered over {@link RUST_TARGET_BUILDERS} by later lanes. */
  builders?: Partial<Record<BuildTarget, RustTargetBuilder>>;
  /**
   * The settings a destination's build needs over the lane's own (the phones', Windows' llvm-mingw,
   * Linux's zig), given the build folder its caches may live in and the lock it builds at; absent or
   * null: none.
   */
  targetSettings?: (
    target: BuildTarget,
    build: { bin: string; lock: ToolchainLock },
  ) => Promise<RustTargetSettings | null>;
  /**
   * The template's WebGPU-only shell the web branch serves as `index.html`, from the app's own
   * resources (never the game's folder); null when the app ships none a build may use.
   */
  webShell?: () => Promise<string | null>;
  /** Runs `xcode-select` and `xcrun` outside the sandbox for the Mac SDK (default: `execFile`). */
  exec?: XcodeExec;
  /** What a game may use of its profile's crate overlay (M3.15); absent: the reviewed allowlist only. */
  crateGrant?: (project: string) => Promise<RustCrateGrant>;
  /**
   * Whether the person trusts the game (`rust-trust.ts`, M7.2) for a build from `dir`; absent or
   * failing: untrusted. Changes the unsafe-code and build-script policy, never the sandbox.
   */
  trust?: (game: { project: string; dir: string }) => Promise<GameTrust>;
  /**
   * The release the person ejected `project`'s engine from (`rust-eject.ts`, the profile's record,
   * M7.1); absent, failing or null: not ejected, and a game's own `[engine]` row stages no fork.
   */
  ejection?: (project: string) => Promise<string | null>;
  /**
   * The host's admission of a build's fresh `out/` before it replaces the last good one (M3.5's
   * `admitRustOutput`: each destination's executable policy and the transport scan). The app
   * always passes it; a stand-in lane without it admits what it built.
   */
  admit?: RustOutputAdmit;
  /**
   * The import step over each build's stage (C-2, `rustStageImporter` in `rust-assets.ts`): the
   * staged assets planned for the destination, the importable ones converted or written back plain
   * in sandboxed jobs, refused ones left out, and the receipt's `assets` record. Absent: the staged
   * assets go out as delivered.
   */
  importAssets?: RustStageImport;
  /** The clock progress, problems and receipts are stamped with (default: `Date.now`). */
  now?: () => number;
}

/** Admits a build's fresh `out/` for its destination: whether a dev build may carry the studio transport. */
export type RustOutputAdmit = (
  out: string,
  target: BuildTarget,
  options: { servesStudio: boolean },
) => Promise<RustOutputAdmission>;

/** Where one game's build for a destination and lock lives: `<root>/<project>-<sha12(source)>/<target>-<digest12>`. */
export function rustBinaryDir(
  root: string,
  project: string,
  source: string,
  target: BuildTarget,
  lock: ToolchainLock,
): string {
  const key = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const folder = SAFE_PROJECT.test(project) ? project : UNNAMED_PROJECT;
  return path.join(path.resolve(root), `${folder}-${key}`, `${target}-${lock.digest.slice(0, 12)}`);
}

/** How many Rust builds may run at once on `cores` cores. */
export function rustBuildsMax(cores: number): number {
  const usable = Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 1;
  return Math.max(1, Math.floor(usable / CORES_PER_BUILD));
}

/** The jobs one build's cargo gets: the cores shared among the builds that may run at once. */
function rustBuildJobs(cores: number): number {
  const usable = Number.isFinite(cores) && cores >= 1 ? Math.floor(cores) : 1;
  return Math.max(1, Math.floor(usable / rustBuildsMax(cores)));
}

/** What a build sandbox factory is built with: the studio's secrets and the core's sandbox to put back. */
export interface RustBuildSandboxesOptions {
  /** Never readable nor writable: the studio's secrets and the engines' homes. */
  secretPaths: readonly string[];
  /**
   * Never readable by a build except its own reads (the stage, the host-written homes, the build
   * folder, the toolchain): the core denies the user's home and the games folder, so a compile-time
   * read the source scan missed reaches nothing of the machine.
   */
  denyRead?: readonly string[];
  /** False only where the core's own sandbox is off. */
  enabled?: boolean;
  /**
   * The core's sandbox, whose config (with the domains its runs in flight opened) goes back into
   * the one process-wide runtime once a build's sandbox has pushed its own, and again once it goes.
   */
  alongside?: Pick<ProcessSandbox, "refreshConfig">;
}

/**
 * A sandbox per build: a `ProcessSandbox` whose only writable root is the build folder and whose
 * `TMPDIR` is the build's own, reading the stage, the host-written homes and the toolchain, with
 * no domain. sandbox-runtime's network filter is process-wide, so a domain a package install
 * opens is open to it too: the lane's commands start from an empty environment, so no build
 * process holds the proxy's settings or its credential.
 */
export function rustBuildSandboxes(
  options: RustBuildSandboxesOptions,
): (spec: RustBuildSandboxSpec) => Promise<RustBuildSandbox> {
  return async (spec) => {
    const sandbox = await ProcessSandbox.create({
      writableRoots: spec.allowWrite,
      scratchDir: spec.tmp,
      secretPaths: [...options.secretPaths],
      readableRoots: spec.reads,
      denyRead: [...(options.denyRead ?? [])],
      denyWrite: spec.denyWrite,
      enabled: options.enabled,
    });
    options.alongside?.refreshConfig();
    return {
      run: (request) => sandbox.run(request),
      dispose: async () => {
        await sandbox.dispose();
        options.alongside?.refreshConfig();
      },
    };
  };
}

/** One build, resolved: the real source root, its build folder, its lock and builder. */
interface Pending {
  game: GameBuildGame;
  target: BuildTarget;
  purpose: CppBuildPurpose;
  builder: Extract<RustTargetBuilder, { ready: true }>;
  source: string;
  bin: string;
  lock: ToolchainLock;
  /** `SDKROOT` of a Mac build; null for every other destination. */
  sdk: string | null;
  /** The destination's own settings over the lane's (a phone's); null for none. */
  settings: Extract<RustTargetSettings, { ok: true }> | null;
}

/** A pending build with its toolchain and sandbox. */
interface Plan extends Pending {
  toolchain: RustToolchain;
  sandbox: RustBuildSandbox;
  /** The steps run so far, timed. */
  steps: RustBuildReceipt["steps"];
  startedAt: number;
  /** The game's title, as staged (the web page's). */
  title: string;
  /** The native-enhanced features the game declares, as staged: the device the facade opens asks for exactly these. */
  nativeFeatures: readonly string[];
  /** The game's `[render]` fragment, as staged; null: none. */
  renderToml: string | null;
  /** The game's `[[wgsl]]` fragment, as staged; null: not compiled in. */
  wgslToml: string | null;
  /** The game's web budget in MB of gzip, as staged; null: the default. */
  wasmBudgetMb: number | null;
  /** The game's `[render.loading]`, as staged; null: the defaults. */
  loading: LoadingStyle | null;
  /** The game's `[[asset_group]]` rows, as staged: the package's named groups (C-30). */
  assetGroups: readonly AssetGroupRow[];
  /** The game's `[assets]`, as staged: the package's budget and a phone's texture cap (C-17); null: the defaults. */
  assetBudgets: AssetsToml | null;
  /** What the game may use of its profile's crate overlay. */
  grant: Extract<RustCrateGrant, { ok: true }>;
  /** The store's own vendored crates (the toolchain's `vendor` is the merged source when the game has a grant). */
  storeVendor: string;
  /** Whether the person trusts the game, and whether it claimed trust itself. */
  trust: GameTrust;
  /** The release the person ejected the game's engine from; null when it builds on the store's engine. */
  ejectedFrom: string | null;
  /** What the import step did with the staged assets; null when it did not run. */
  assets: StagedImportReport | null;
  /** How an export keeps its debug files (CRASH-7a); null for every other build, set once the compiler is known. */
  debug: ExportDebug | null;
}

/** An export's debug files: how they are kept, and the toolchain's `llvm-objcopy` for a kind that strips. */
interface ExportDebug {
  kind: DebugFileKind;
  objcopy: string | null;
}

/** A build running (or waiting for a slot), which later looks at the same folder join; each caller waits with its own signal. */
interface InFlight {
  controller: AbortController;
  done: Promise<BuildOutcome>;
  waiters: number;
}

/** What one step answered: its run, or null when Stop came first. */
type StepRun = RunResult | null;

/** The Rust · wgpu build lane: one build per game, destination and lock, each in its own sandbox. */
export class RustBuilds implements GameBuildLane {
  readonly options: RustBuildsOptions;
  readonly #inFlight = new Map<string, InFlight>();
  readonly #waiting: Array<() => void> = [];
  #active = 0;
  /** The lock digest last recorded per project, so the library is written once per change. */
  readonly #recorded = new Map<string, string>();

  constructor(options: RustBuildsOptions) {
    this.options = options;
  }

  /**
   * Build `game` for `target`: the served `out/` (outside the build folder) or the problem, with
   * the lane's typed report. Refusals run nothing. A second look at the same folder while it
   * builds shares that build; each caller's signal ends only its own wait.
   */
  async ensure(
    game: GameBuildGame,
    target: BuildTarget,
    purpose: CppBuildPurpose,
    options: GameBuildOptions = {},
  ): Promise<BuildOutcome> {
    const asked = { game, target, purpose };
    const refused = this.#targetRefusal(game, target);
    if (refused) return this.#refused(asked, refused.code, refused.lines, null, refused.rust);
    const builder = this.#builder(target);
    if (!builder.ready)
      return this.#refused(asked, BuildProblemCode.UnsupportedHost, [], null, RustBuildRefusal.TargetUnbuilt);
    const sdk = builder.macSdk ? await macSdkPath(this.options.exec ?? execXcode, this.options.platform) : null;
    if (builder.macSdk && !sdk) return this.#refused(asked, BuildProblemCode.CltMissing);
    const lock = game.lock ?? (await this.options.currentLock().catch(() => null));
    if (!lock || !isLockDigest(lock.digest)) return this.#refused(asked, BuildProblemCode.ToolchainMissing);
    const source = await realpath(game.dir).catch(() => path.resolve(game.dir));
    const bin = rustBinaryDir(this.options.root, game.project, source, target, lock);
    const settings = (await this.options.targetSettings?.(target, { bin, lock })) ?? null;
    if (settings && !settings.ok) {
      const lines = [MESSAGE.settingsRefused(settings.code, settings.detail)];
      return this.#refused(asked, BuildProblemCode.ToolchainMissing, lines, null, RustBuildRefusal.TargetSettings);
    }
    const pending: Pending = { game, target, purpose, builder, source, bin, lock, sdk, settings };
    const running = this.#inFlight.get(bin);
    const flight = running && !running.controller.signal.aborted ? running : this.#start(pending, running ?? null);
    return await this.#wait(flight, pending, options.signal);
  }

  /** Composer Stop and the app's stop: every build in flight or waiting aborts; nothing in flight is no error. */
  cancelAll(): void {
    for (const flight of this.#inFlight.values()) flight.controller.abort();
  }

  /**
   * Removes the build folders nothing will build again, with everything named after them beside:
   * those whose source root is gone or unknown, and those of a lock that is neither the current one
   * nor one a game of the library recorded ({@link RustBuildsOptions.retainedLocks}). A project with
   * a build in flight is left whole; nothing is followed through a link.
   */
  async sweep(): Promise<number> {
    const root = path.resolve(this.options.root);
    if (!(await lstat(root).catch(() => null))?.isDirectory()) return 0;
    const keep = await this.#keptLocks();
    const busy = new Set([...this.#inFlight.keys()].map((bin) => path.dirname(bin)));
    let removed = 0;
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const project = path.join(root, name);
      if (!PROJECT_FOLDER.test(name) || busy.has(project)) continue;
      if (!(await lstat(project).catch(() => null))?.isDirectory()) continue;
      removed += await sweepProject(project, keep);
    }
    return removed;
  }

  /**
   * The short digests whose build folders the sweep keeps: the current lock's and every recorded
   * one; null when either cannot be read, and then no folder goes for its lock alone.
   */
  async #keptLocks(): Promise<ReadonlySet<string> | null> {
    const lock = await this.options.currentLock().catch(() => null);
    if (!lock || !isLockDigest(lock.digest)) return null;
    const recorded = await (this.options.retainedLocks?.() ?? Promise.resolve([])).catch(() => null);
    if (recorded === null) return null;
    const digests = [lock.digest, ...recorded.filter((digest) => isLockDigest(digest))];
    return new Set(digests.map((digest) => digest.slice(0, 12)));
  }

  #builder(target: BuildTarget): RustTargetBuilder {
    return this.options.builders?.[target] ?? RUST_TARGET_BUILDERS[target];
  }

  /**
   * Why `target` is refused before anything is made: a host the lane does not run on, a
   * destination the game does not name (the web always builds), a destination whose builder has
   * not landed, or one this host does not build.
   */
  #targetRefusal(game: GameBuildGame, target: BuildTarget): Refusal | null {
    const host = hostOf(this.options.platform);
    const builds: readonly BuildTarget[] = host ? STACK_HOST_MATRIX[GameStack.RustWgpu][host].build : [];
    if (builds.length === 0) return { code: BuildProblemCode.UnsupportedHost };
    if (target !== BuildTarget.Web && !game.destinations.targets.includes(target))
      return { code: BuildProblemCode.NotADestination };
    if (!this.#builder(target).ready)
      return {
        code: BuildProblemCode.UnsupportedHost,
        lines: [MESSAGE.targetUnbuilt(target)],
        rust: RustBuildRefusal.TargetUnbuilt,
      };
    return builds.includes(target) ? null : { code: BuildProblemCode.MacBuildsNeedAMac };
  }

  #start(pending: Pending, cancelled: InFlight | null): InFlight {
    const controller = new AbortController();
    const start = () => this.#build(pending, controller.signal);
    const done = cancelled ? cancelled.done.then(start, start) : start();
    const flight: InFlight = { controller, done, waiters: 0 };
    this.#inFlight.set(pending.bin, flight);
    const forget = () => {
      if (this.#inFlight.get(pending.bin) === flight) this.#inFlight.delete(pending.bin);
    };
    done.then(forget, forget);
    return flight;
  }

  /** One caller's wait: the outcome, or `Cancelled` once its own signal aborts; the last to leave cancels the build. */
  async #wait(flight: InFlight, pending: Pending, signal: AbortSignal | undefined): Promise<BuildOutcome> {
    flight.waiters += 1;
    if (!signal) return await flight.done;
    let leave = () => {};
    const left = new Promise<null>((resolve) => {
      leave = () => resolve(null);
      if (signal.aborted) leave();
      else signal.addEventListener("abort", leave, { once: true });
    });
    try {
      const outcome = await Promise.race([flight.done, left]);
      if (outcome) return outcome;
      flight.waiters -= 1;
      if (flight.waiters === 0) flight.controller.abort();
      const lastGood = await lastAdmitted(pending.bin);
      return this.#outcome(pending, BuildProblemCode.Cancelled, { lastGood, announce: false });
    } finally {
      signal.removeEventListener("abort", leave);
    }
  }

  /** The person's trust for the game, as the profile holds it; untrusted when it cannot be read. */
  async #trustOf(pending: Pending): Promise<GameTrust> {
    const game = { project: pending.game.project, dir: pending.source };
    return (await this.options.trust?.(game).catch(() => UNTRUSTED)) ?? UNTRUSTED;
  }

  /** The person's recorded eject of the game; null (Studio's engine) when there is none or it cannot be read. */
  async #ejectedFrom(pending: Pending): Promise<string | null> {
    return (await this.options.ejection?.(pending.game.project).catch(() => null)) ?? null;
  }

  /** Locate, take a slot, open the build's sandbox, build, and let everything go. */
  async #build(pending: Pending, signal: AbortSignal): Promise<BuildOutcome> {
    const located = await this.options
      .locate(pending.lock, pending.target)
      .catch((error: unknown): RustLocateResult => ({ ok: false, missing: [errorMessage(error)] }));
    const lastGood = await lastAdmitted(pending.bin);
    if (!located.ok) return this.#outcome(pending, toolchainRefusal(located), { lines: located.missing, lastGood });
    const grant = (await this.options.crateGrant?.(pending.game.project)) ?? NO_GRANT;
    if (!grant.ok) {
      const lines = [MESSAGE.crateRefused(grant.refusal, grant.detail)];
      return this.#outcome(pending, BuildProblemCode.CommandFailed, {
        lines,
        lastGood,
        rust: RustBuildRefusal.DependencyNotAllowed,
        crate: { name: null, refusal: grant.refusal },
      });
    }
    const trust = await this.#trustOf(pending);
    const scripts = rustTrustPolicy(trust.trusted).buildScripts ? [] : await ownBuildScripts(pending.source);
    if (scripts.length) {
      return this.#outcome(pending, BuildProblemCode.CommandFailed, {
        lines: trustLines(MESSAGE.buildScripts(scripts), trust),
        lastGood,
        extension: ExtensionRefusal.BuildScriptRefused,
      });
    }
    const release = await this.#slot(signal);
    if (!release) return this.#outcome(pending, BuildProblemCode.Cancelled, { lastGood });
    let sandbox: RustBuildSandbox | null = null;
    try {
      this.#emit(pending, BuildPhase.Configure);
      const toolchain = withGrant(pending.bin, located.toolchain, grant);
      const spec = await this.#prepare(pending, toolchain, grant, located.toolchain.vendor);
      sandbox = await this.options.sandbox(spec);
      const startedAt = this.#now();
      const plan: Plan = {
        ...pending,
        toolchain,
        sandbox,
        steps: [],
        startedAt,
        title: "",
        nativeFeatures: [],
        renderToml: null,
        wgslToml: null,
        wasmBudgetMb: null,
        loading: null,
        assetGroups: [],
        assetBudgets: null,
        grant,
        storeVendor: located.toolchain.vendor,
        trust,
        ejectedFrom: await this.#ejectedFrom(pending),
        assets: null,
        debug: null,
      };
      return await this.#steps(plan, signal, lastGood);
    } catch (error) {
      if (signal.aborted) return this.#outcome(pending, BuildProblemCode.Cancelled, { lastGood });
      return this.#outcome(pending, BuildProblemCode.CommandFailed, { lines: [errorMessage(error)], lastGood });
    } finally {
      await sandbox?.dispose().catch(() => {});
      release();
    }
  }

  /** Stage, verify the dependencies, then the sandboxed steps: identity, lock, clippy, build; then admit. */
  async #steps(plan: Plan, signal: AbortSignal, lastGood: string | null): Promise<BuildOutcome> {
    const flavour = rustFlavourOf(plan.purpose, plan.target);
    // Staged from the real source root the build folder is keyed by, never the path as the game named it.
    const game = { project: plan.game.project, dir: plan.source };
    const staged = await this.options.stage(
      game,
      stageDir(plan.bin),
      plan.target,
      flavour,
      plan.lock,
      plan.storeVendor,
      plan.ejectedFrom,
    );
    if (!staged.ok) {
      const lines = [`${staged.code}: ${staged.detail}`];
      return this.#outcome(plan, BuildProblemCode.CommandFailed, {
        lines,
        lastGood,
        rust: RustBuildRefusal.StageRefused,
      });
    }
    const refused = await this.#stageRefusal(plan);
    if (refused !== null) {
      return this.#outcome(plan, BuildProblemCode.CommandFailed, {
        lines: [refused],
        lastGood,
        rust: RustBuildRefusal.StageRefused,
      });
    }
    adoptStaged(plan, staged);
    const outside = staged.dependencies.filter(
      (name) => name !== FACADE_CRATE && !Object.hasOwn(RUST_CRATE_ALLOWLIST, name) && !plan.grant.names.includes(name),
    );
    if (outside.length) {
      return this.#outcome(plan, BuildProblemCode.CommandFailed, {
        ...outsideRefusal(outside, plan.grant),
        lastGood,
        rust: RustBuildRefusal.DependencyNotAllowed,
      });
    }
    if (!(await this.#importAssets(plan, signal))) return this.#outcome(plan, BuildProblemCode.Cancelled, { lastGood });
    const identity = await this.#step(plan, RustBuildStep.Identity, rustcCommand(plan), IDENTITY_TIMEOUT_MS, signal);
    if (!succeeded(identity)) return this.#failed(plan, identity, signal, lastGood);
    const compiler = parseRustcIdentity(identity.stdout);
    plan.debug = await exportDebugOf(plan, compiler);
    const locked = await this.#lock(plan, signal, lastGood);
    if (locked) return locked;
    this.#emit(plan, BuildPhase.Build);
    const timeout = RUST_BUILD_TIMEOUT_MS[plan.target];
    const clippy = await this.#step(plan, RustBuildStep.Clippy, clippyCommand(plan, this.#jobs()), timeout, signal);
    if (!succeeded(clippy)) return this.#failed(plan, clippy, signal, lastGood);
    const build = await this.#step(plan, RustBuildStep.Build, buildCommand(plan, this.#jobs()), timeout, signal);
    if (!succeeded(build)) return this.#failed(plan, build, signal, lastGood);
    return await this.#admit(plan, build, compiler, lastGood, signal);
  }

  /**
   * Why a stage the stager made cannot be built, as the refusal's line: a game file at a name the
   * package step writes (`reserved-asset-name`, C-15), or a trusted game's linked build script.
   * Null when it holds.
   */
  async #stageRefusal(plan: Plan): Promise<string | null> {
    const reserved = await reservedAssetName(stageDir(plan.bin));
    if (reserved) return `${PackageRefusal.ReservedAssetName}: ${reserved}`;
    const scriptStaged = !plan.trust.trusted || (await stageBuildScript(plan.source, stageDir(plan.bin)));
    return scriptStaged ? null : MESSAGE.buildScriptLinked(BUILD_SCRIPT_FILE);
  }

  /**
   * The import step over the stage (C-2), for a destination whose `out/` carries the assets: the
   * report kept for the receipt. False only when Stop came during it.
   */
  async #importAssets(plan: Plan, signal: AbortSignal): Promise<boolean> {
    const step = this.options.importAssets;
    if (!step || !plan.builder.assets) return true;
    plan.assets = await step({ stage: stageDir(plan.bin), target: plan.target, signal });
    return plan.assets !== null && !signal.aborted;
  }

  /**
   * The lock, generated offline against the vendored registry in the build folder, read back and
   * verified, then written into the stage. Null when it holds; the refusal or failure otherwise.
   */
  async #lock(plan: Plan, signal: AbortSignal, lastGood: string | null): Promise<BuildOutcome | null> {
    // In the build folder, which an earlier build's run could write: made afresh, every folder a real one.
    const lockDir = path.join(plan.bin, LOCK_DIR);
    await rm(lockDir, { recursive: true, force: true });
    await ownFolder(lockDir);
    await ownFolder(path.join(lockDir, "src"));
    await copyFile(path.join(stageDir(plan.bin), MANIFEST_FILE), path.join(lockDir, MANIFEST_FILE));
    await writeFile(path.join(lockDir, "src", "main.rs"), LOCK_STUB_MAIN);
    // An ejected game's manifest patches the engine to its staged fork (`engine/<crate>`, M7.1).
    await copyStagedEngine(stageDir(plan.bin), lockDir);
    const run = await this.#step(plan, RustBuildStep.Lock, lockCommand(plan, lockDir), LOCK_TIMEOUT_MS, signal);
    if (!succeeded(run)) return this.#failed(plan, run, signal, lastGood);
    const text = await readRegularFile(path.join(lockDir, LOCK_FILE), LOCK_MAX_BYTES).then(
      (bytes) => bytes.toString("utf8"),
      () => null,
    );
    const vendors = [plan.storeVendor, ...(plan.grant.vendor === null ? [] : [plan.grant.vendor])];
    const refusal = text === null ? MESSAGE.lockUnreadable : await lockRefusal(text, vendors, plan.grant);
    if (refusal) {
      const lines = [refusal];
      return this.#outcome(plan, BuildProblemCode.CommandFailed, {
        lines,
        lastGood,
        ran: true,
        rust: RustBuildRefusal.LockRefused,
      });
    }
    await atomicWriteText(path.join(stageDir(plan.bin), LOCK_FILE), text ?? "");
    return null;
  }

  /** One timed command in the build's sandbox, from `/`; null when Stop came first. */
  async #step(
    plan: Plan,
    step: RustBuildStep,
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<StepRun> {
    if (signal.aborted) return null;
    const started = this.#now();
    const result = await plan.sandbox.run({
      command,
      cwd: CARGO_CWD,
      timeoutMs,
      signal,
      reapGroup: true,
      maxOutputBytes: OUTPUT_MAX_BYTES,
      label: `rust:${plan.game.project}:${plan.target}:${step}`,
    });
    plan.steps.push({ step, ms: Math.max(0, this.#now() - started), code: result.code });
    return result;
  }

  /**
   * The executable cargo named (for the web, the folder the web branch packaged from it), copied
   * with the staged assets into `<bin>.out` (outside every build-writable path), its digests
   * recorded beside it, and the receipt written.
   */
  async #admit(
    plan: Plan,
    build: RunResult,
    compiler: RustCompilerIdentity,
    lastGood: string | null,
    signal: AbortSignal,
  ): Promise<BuildOutcome> {
    const manifest = path.join(stageDir(plan.bin), MANIFEST_FILE);
    const messages = parseCargoMessages(build.stdout, stageDir(plan.bin), manifest);
    const exe = messages.executables.at(-1);
    if (!exe)
      return this.#outcome(plan, BuildProblemCode.CommandFailed, {
        lines: [MESSAGE.noArtifact],
        lastGood,
        ran: true,
        rust: RustBuildRefusal.NoArtifact,
      });
    const inside = await builtInside(plan.bin, exe);
    if (!inside) {
      const lines = [MESSAGE.artifactRefused(path.basename(exe))];
      return this.#outcome(plan, BuildProblemCode.CommandFailed, {
        lines,
        lastGood,
        ran: true,
        rust: RustBuildRefusal.ArtifactRefused,
      });
    }
    const shipped = await this.#shipped(plan, inside, lastGood, signal);
    if (typeof shipped !== "string") return shipped;
    const web = plan.target === BuildTarget.Web ? await this.#packageWeb(plan, inside, signal) : null;
    if (web && !web.ok) {
      if (signal.aborted) return this.#outcome(plan, BuildProblemCode.Cancelled, { lastGood, ran: true });
      return this.#outcome(plan, BuildProblemCode.CommandFailed, { ...web.refusal, lastGood, ran: true });
    }
    const written = await writeOutput(plan, shipped, web ? path.join(plan.bin, WEB_DIR) : null, this.options.admit);
    if (!written.ok && "packageRefused" in written) {
      return this.#outcome(plan, BuildProblemCode.CommandFailed, {
        lines: [written.packageRefused],
        lastGood,
        ran: true,
        rust: RustBuildRefusal.PackageRefused,
      });
    }
    if (!written.ok) {
      const { file, refusal, problem, detail } = written.refused;
      return this.#outcome(plan, BuildProblemCode.CommandFailed, {
        lines: [MESSAGE.admissionRefused(file, refusal, detail)],
        lastGood,
        ran: true,
        rust: RustBuildRefusal.AdmissionRefused,
        admission: { file, refusal, problem },
      });
    }
    const { outputs } = written;
    const receipt = this.#receipt(plan, compiler, outputs, web?.receipt ?? null, written.package);
    await atomicWriteText(`${plan.bin}${RECEIPT_SUFFIX}`, `${JSON.stringify(receipt, null, 2)}\n`);
    await this.#keepDebug(plan, inside, outputs);
    if (plan.game.recordLock) await this.#recordLock(plan.game.project, plan.lock.digest);
    this.#emit(plan, BuildPhase.Done);
    const output = `${plan.bin}${OUT_SUFFIX}`;
    return {
      ok: true,
      output,
      lastGood: output,
      problem: null,
      ran: true,
      rust: { refusal: null, diagnostics: [], receipt },
    };
  }

  /**
   * The executable the build ships ({@link RustBuilds.#stripped}) in a fresh debug stage, or the
   * refusal when an export's strip failed: nothing of it ships.
   */
  async #shipped(
    plan: Plan,
    exe: string,
    lastGood: string | null,
    signal: AbortSignal,
  ): Promise<string | BuildOutcome> {
    if (plan.debug) await freshFolder(path.join(plan.bin, DEBUG_STAGE_DIR));
    const shipped = await this.#stripped(plan, exe, signal);
    if ("file" in shipped) return shipped.file;
    if (signal.aborted) return this.#outcome(plan, BuildProblemCode.Cancelled, { lastGood, ran: true });
    return this.#outcome(plan, BuildProblemCode.CommandFailed, {
      lines: [MESSAGE.stripFailed(path.basename(exe), shipped.failed)],
      lastGood,
      ran: true,
      rust: RustBuildRefusal.ArtifactRefused,
    });
  }

  /**
   * The executable an export ships: for a kind that strips (ELF and PE), the copy the toolchain's
   * `llvm-objcopy --strip-debug` wrote in the build's sandbox; otherwise cargo's own. `failed`
   * (the tool's exit code) when the strip wrote no file or Stop came.
   */
  async #stripped(plan: Plan, exe: string, signal: AbortSignal): Promise<{ file: string } | { failed: number | null }> {
    const objcopy = plan.debug?.kind === DebugFileKind.Unstripped ? plan.debug.objcopy : null;
    if (objcopy === null) return { file: exe };
    const to = path.join(plan.bin, DEBUG_STAGE_DIR, path.basename(exe));
    const run = await plan.sandbox.run({
      command: `exec ${envPrefix(plan)} ${stripDebugCommand(objcopy, exe, to)}`,
      cwd: CARGO_CWD,
      timeoutMs: STRIP_TIMEOUT_MS,
      signal,
      reapGroup: true,
      maxOutputBytes: OUTPUT_MAX_BYTES,
      label: `rust:${plan.game.project}:${plan.target}:strip`,
    });
    if (run.code !== 0 || signal.aborted) return { failed: run.code };
    return (await lstat(to).catch(() => null))?.isFile() ? { file: to } : { failed: run.code };
  }

  /**
   * An export's debug files kept in `<bin>.debug/<digest>/` by the shipped file's digest (the one
   * a run's `BuildIdentity` carries). Best effort: a failure here never fails the build.
   */
  async #keepDebug(plan: Plan, exe: string, outputs: RustBuildReceipt["outputs"]): Promise<void> {
    if (!plan.debug) return;
    const [name] = plan.builder.executables;
    const shippedName = plan.target === BuildTarget.Web ? WEB_FILES.wasm : name;
    const digest = outputs.find((file) => file.path === shippedName)?.sha256;
    if (!digest || !name) return;
    await keepDebugFiles({
      bin: plan.bin,
      digest,
      target: plan.target,
      triple: plan.builder.triple,
      kind: plan.debug.kind,
      sources: debugSources(plan.debug.kind, exe, name, plan.bin),
      within: plan.bin,
      now: () => this.#now(),
    }).catch(() => null);
  }

  /**
   * The web branch over the module cargo built: the app's shell and the store's tools, packaged
   * into `<bin>/web` through the build's own sandbox with every command from an empty environment;
   * wasm-opt runs for an export. Answers the receipt, or the refusal's lines and code.
   */
  async #packageWeb(plan: Plan, wasm: string, signal: AbortSignal): Promise<WebPackaged> {
    const shell = await this.options.webShell?.().catch(() => null);
    if (!shell) return webRefused([MESSAGE.webShellMissing], RustBuildRefusal.WebShellMissing);
    const tools = plan.toolchain.web;
    if (!tools) return webRefused([MESSAGE.webToolsMissing], RustBuildRefusal.WebPackageRefused);
    const started = this.#now();
    const packaged = await packageWeb({
      wasm,
      out: path.join(plan.bin, WEB_DIR),
      shell,
      title: plan.title,
      ...(plan.loading === null ? {} : { loading: plan.loading }),
      optimize: plan.purpose === CppBuildPurpose.Export,
      ...(plan.debug?.kind === DebugFileKind.SymbolMap
        ? { symbolMap: path.join(plan.bin, DEBUG_STAGE_DIR, WEB_SYMBOL_MAP_FILE) }
        : {}),
      ...(plan.wasmBudgetMb === null ? {} : { budgetMb: plan.wasmBudgetMb }),
      tools,
      run: async (line, step) => {
        const result = await plan.sandbox.run({
          command: `exec ${envPrefix(plan)} ${line}`,
          cwd: CARGO_CWD,
          timeoutMs: RUST_WEB_STEP_TIMEOUT_MS,
          signal,
          reapGroup: true,
          maxOutputBytes: OUTPUT_MAX_BYTES,
          label: `rust:${plan.game.project}:${plan.target}:${step}`,
        });
        return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      },
    });
    plan.steps.push({ step: RustBuildStep.WebPackage, ms: Math.max(0, this.#now() - started), code: null });
    if (packaged.ok) return { ok: true, receipt: packaged.receipt };
    const lines = [MESSAGE.webRefused(packaged.refusal, packaged.detail)];
    return webRefused(lines, RustBuildRefusal.WebPackageRefused);
  }

  #receipt(
    plan: Plan,
    compiler: RustCompilerIdentity,
    outputs: RustBuildReceipt["outputs"],
    web: WebReceipt | null,
    pack: AssetPackageReport | null,
  ): RustBuildReceipt {
    return {
      version: 1,
      project: plan.game.project,
      target: plan.target,
      triple: plan.builder.triple,
      profile: profileOf(plan.purpose),
      lock: plan.lock.digest,
      compiler,
      startedAt: new Date(plan.startedAt).toISOString(),
      finishedAt: this.#at(),
      steps: plan.steps,
      outputs,
      ...(web ? { web } : {}),
      ...(plan.assets ? { assets: plan.assets } : {}),
      ...(pack ? { package: pack } : {}),
    };
  }

  /**
   * The host-side folders of a build, every one a real folder: the build folder (with its target
   * and private TMPDIR), a fresh stage, a host-written CARGO_HOME and an empty HOME; and the
   * sandbox the build runs in.
   */
  async #prepare(
    pending: Pending,
    toolchain: RustToolchain,
    grant: Extract<RustCrateGrant, { ok: true }>,
    storeVendor: string,
  ): Promise<RustBuildSandboxSpec> {
    const root = path.resolve(this.options.root);
    await mkdir(path.dirname(root), { recursive: true });
    for (const dir of [root, path.dirname(pending.bin), pending.bin]) await ownFolder(dir);
    await atomicWriteText(`${pending.bin}${SOURCE_SUFFIX}`, pending.source);
    for (const dir of [TARGET_DIR, TMP_DIR]) await ownFolder(path.join(pending.bin, dir));
    const stage = stageDir(pending.bin);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage);
    await writeHomes(pending.bin, toolchain);
    if (!(await realFolders(root, pending.bin))) throw new Error(MESSAGE.linked(pending.bin));
    // The directory source cargo reads: the store's crates and the game's granted overlay crates, as host links.
    if (grant.vendor !== null) await mergedVendor(storeVendor, grant.crates, grant.vendor, toolchain.vendor);
    const reads = [
      pending.bin,
      stage,
      `${pending.bin}${CARGO_HOME_SUFFIX}`,
      `${pending.bin}${HOME_SUFFIX}`,
      ...toolchain.reads,
      ...(pending.settings?.reads ?? []),
    ];
    return {
      bin: pending.bin,
      tmp: path.join(pending.bin, TMP_DIR),
      allowWrite: [pending.bin],
      reads,
      denyWrite: await this.#denyWrite(pending),
      allowedDomains: [],
    };
  }

  /** The source root and the paths no build writes, as named and as real (literal globs on a Mac). */
  async #denyWrite(pending: Pending): Promise<string[]> {
    const named = [
      pending.source,
      path.resolve(pending.game.dir),
      ...this.options.denyWrite.map((p) => path.resolve(p)),
    ];
    const real = await Promise.all(named.map((p) => realpath(p).catch(() => p)));
    const literal = this.options.platform === StudioPlatform.Mac ? literalGlob : (p: string) => p;
    return [...new Set([...named, ...real].map(literal))];
  }

  /** A failed step: its diagnostics and rendered lines, or its first output lines; `Cancelled` when Stop ended it. */
  async #failed(plan: Plan, result: StepRun, signal: AbortSignal, lastGood: string | null): Promise<BuildOutcome> {
    if (!result || signal.aborted) return this.#outcome(plan, BuildProblemCode.Cancelled, { lastGood, ran: true });
    const manifest = path.join(stageDir(plan.bin), MANIFEST_FILE);
    const messages: CargoMessages = parseCargoMessages(result.stdout, stageDir(plan.bin), manifest);
    const rendered = diagnosticLines(messages);
    const lines = rendered.length ? rendered : outputLinesOf(result);
    // A step the system killed (memory or disk) prints nothing: name the signal, never an empty problem.
    const killedBy = lines.length === 0 && !result.timedOut ? result.signal : null;
    if (killedBy) lines.push(MESSAGE.stoppedBySignal(killedBy));
    const reason = result.timedOut ? BuildProblemCode.TimedOut : BuildProblemCode.CommandFailed;
    const problem = { command: result.command, code: result.code, diagnostics: messages.diagnostics };
    const unsafeRefused = !plan.trust.trusted && messages.diagnostics.some((d) => d.code === UNSAFE_CODE_LINT);
    if (!unsafeRefused) return this.#outcome(plan, reason, { lines, lastGood, ran: true, failure: problem });
    const refused = [...trustLines(MESSAGE.unsafeCode, plan.trust), ...lines];
    const extension = ExtensionRefusal.UnsafeCode;
    return this.#outcome(plan, reason, { lines: refused, lastGood, ran: true, failure: problem, extension });
  }

  /** A build's answer that is not a success: the stage's problem and the lane's report. */
  #outcome(asked: Asked, reason: BuildProblemCode, detail: OutcomeDetail = {}): BuildOutcome {
    const lastGood = detail.lastGood ?? null;
    const base = refusalProblem({
      project: asked.game.project,
      target: asked.target,
      reason,
      lines: detail.lines ?? [],
      showingLastBuild: lastGood !== null,
      at: this.#at(),
    });
    const problem: BuildProblem = detail.failure
      ? { ...base, command: detail.failure.command, code: detail.failure.code }
      : base;
    if (detail.announce !== false) this.#emit(asked, BuildPhase.Failed);
    const rust: RustLaneReport = {
      refusal: detail.rust ?? null,
      diagnostics: detail.failure?.diagnostics ?? [],
      receipt: null,
      ...(detail.crate ? { crate: detail.crate } : {}),
      ...(detail.admission ? { admission: detail.admission } : {}),
      ...(detail.extension ? { extension: detail.extension } : {}),
    };
    return { ok: false, output: null, lastGood, problem, ran: detail.ran ?? false, rust };
  }

  #refused(
    asked: Asked,
    reason: BuildProblemCode,
    lines: string[] = [],
    lastGood: string | null = null,
    rust?: RustBuildRefusal,
  ): BuildOutcome {
    return this.#outcome(asked, reason, { lines, lastGood, ...(rust ? { rust } : {}) });
  }

  /** One slot of `rustBuildsMax(cores)`, or null when the build was cancelled while it waited. */
  async #slot(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return null;
    const release = () => {
      this.#active--;
      this.#waiting.shift()?.();
    };
    if (this.#active < rustBuildsMax(this.options.cores)) {
      this.#active++;
      return release;
    }
    return await new Promise((resolve) => {
      const take = () => {
        signal.removeEventListener("abort", leave);
        this.#active++;
        resolve(release);
      };
      const leave = () => {
        const at = this.#waiting.indexOf(take);
        if (at >= 0) this.#waiting.splice(at, 1);
        resolve(null);
      };
      this.#waiting.push(take);
      signal.addEventListener("abort", leave, { once: true });
    });
  }

  /** The lock is recorded once per project and digest; a record that cannot be written does not undo a build. */
  async #recordLock(project: string, digest: string): Promise<void> {
    if (this.#recorded.get(project) === digest) return;
    try {
      await this.options.writeLock(project, digest);
      this.#recorded.set(project, digest);
    } catch {
      // Not recorded, so the next build that works tries again.
    }
  }

  #jobs(): number {
    return rustBuildJobs(this.options.cores);
  }

  #emit(asked: Asked, phase: BuildPhase): void {
    const { game, target, purpose } = asked;
    this.options.emit({ project: game.project, target, purpose, phase, at: this.#now() });
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }
}

/** Why a build is refused before anything is made: the stage's code, its facts and the lane's own code. */
interface Refusal {
  code: BuildProblemCode;
  lines?: string[];
  rust?: RustBuildRefusal;
}

/** What an answer is about: the game, the destination and why it was built. */
interface Asked {
  game: GameBuildGame;
  target: BuildTarget;
  purpose: CppBuildPurpose;
}

/** How a build that did not succeed is answered. */
interface OutcomeDetail {
  lines?: string[];
  lastGood?: string | null;
  /** A command ran (default: nothing ran). */
  ran?: boolean;
  rust?: RustBuildRefusal;
  /** The crate decision behind a `dependency-not-allowed` refusal. */
  crate?: RustCrateRefusal;
  /** What the host's admission refused behind an `admission-refused`. */
  admission?: RustAdmissionRefusal;
  /** The trust policy behind the refusal (`unsafe-code`, `build-script-refused`). */
  extension?: ExtensionRefusal;
  /** The step that failed: its command line, exit code and diagnostics. */
  failure?: { command: string; code: number | null; diagnostics: RustLaneReport["diagnostics"] };
  /** False: a caller that only stopped waiting says nothing on `build.progress`. */
  announce?: boolean;
}

/** What the web branch answered: its receipt, or the refusal's lines and the lane's code. */
type WebPackaged =
  | { ok: true; receipt: WebReceipt }
  | { ok: false; refusal: { lines: string[]; rust: RustBuildRefusal } };

function webRefused(lines: string[], rust: RustBuildRefusal): WebPackaged {
  return { ok: false, refusal: { lines, rust } };
}

/** The destinations whose dev builds a studio runs over fd 3: the desktops (never the browser or a phone). */
const STUDIO_SERVED: ReadonlySet<BuildTarget> = new Set([BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux]);

/** The facade a build links: the dev flavour for a desktop game's Live and judging builds, an export's otherwise. */
export function rustFlavourOf(purpose: CppBuildPurpose, target: BuildTarget): RustFlavour {
  const servesStudio = purpose !== CppBuildPurpose.Export && STUDIO_SERVED.has(target);
  return servesStudio ? RustFlavour.Dev : RustFlavour.Export;
}

/** Whether a step ran and exited 0. */
function succeeded(run: StepRun): run is RunResult {
  return run !== null && run.code === 0;
}

/**
 * Why crates outside the facade and the reviewed list refuse a build: a crate a decision refused
 * says why, typed (`crate`); one never approved is off the reviewed list.
 */
function outsideRefusal(
  outside: readonly string[],
  grant: Extract<RustCrateGrant, { ok: true }>,
): Pick<OutcomeDetail, "lines" | "crate"> {
  const refused = outside.find((name) => Object.hasOwn(grant.refused, name));
  const code = refused === undefined ? undefined : grant.refused[refused];
  if (!code || refused === undefined) return { lines: [MESSAGE.notAllowed(outside)] };
  return { lines: [MESSAGE.crateRefused(code, refused)], crate: { name: refused, refusal: code } };
}

/** A refusal's lines: why, after the game's own claim to trust when it made one. */
function trustLines(why: string, trust: GameTrust): string[] {
  return trust.claim === ExtensionRefusal.TrustPersonOnly ? [why, MESSAGE.trustClaimed] : [why];
}

/**
 * A trusted game's own `build.rs`, copied into the stage with the host-written manifest pointed at
 * it. Nothing when the game has none; false when it is a link, a hard link or not a file.
 */
async function stageBuildScript(source: string, stage: string): Promise<boolean> {
  const from = path.join(source, BUILD_SCRIPT_FILE);
  if (!(await lstat(from).catch(() => null))) return true;
  const bytes = await readOwnFile(from, BUILD_SCRIPT_MAX_BYTES);
  if (bytes === null) return false;
  await writeFile(path.join(stage, BUILD_SCRIPT_FILE), bytes);
  const manifest = path.join(stage, MANIFEST_FILE);
  const text = (await readRegularFile(manifest, STAMP_MAX_BYTES)).toString("utf8");
  await writeFile(manifest, text.replace(NO_BUILD_SCRIPT_LINE, BUILD_SCRIPT_LINE));
  return true;
}

/**
 * The bytes of a file the game holds by one name only, read through its own open handle: null for
 * a link, a hard link (it may be a file outside the game), anything but a regular file, or more
 * than `maxBytes`.
 */
async function readOwnFile(file: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await openNoFollow(file, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    const own = info.isFile() && info.nlink === 1 && info.size <= maxBytes;
    return own ? await handle.readFile() : null;
  } finally {
    await handle.close();
  }
}

/** The `Cargo.lock` the admitted build at `output` (`<bin>.out`) was built with: `<bin>.stage/Cargo.lock`. */
export function admittedBuildLock(output: string): string {
  const bin = output.endsWith(OUT_SUFFIX) ? output.slice(0, -OUT_SUFFIX.length) : output;
  return path.join(stageDir(bin), LOCK_FILE);
}

/** The host's staged copy of a build's game, beside its build folder. */
function stageDir(bin: string): string {
  return `${bin}${STAGE_SUFFIX}`;
}

function profileOf(purpose: CppBuildPurpose): string {
  return purpose === CppBuildPurpose.Export ? PROFILE.release : PROFILE.dev;
}

/**
 * The host-written `CARGO_HOME` (its `config.toml`: the vendored registry in place of crates.io,
 * offline) and an empty `HOME`, both beside the build folder, rewritten for every build.
 */
async function writeHomes(bin: string, toolchain: RustToolchain): Promise<void> {
  const cargoHome = `${bin}${CARGO_HOME_SUFFIX}`;
  const home = `${bin}${HOME_SUFFIX}`;
  for (const dir of [cargoHome, home]) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
  }
  const config = [
    "# Written by the studio's Rust lane for one build: crates.io is the vendored tree, and cargo stays offline.",
    "[source.crates-io]",
    `replace-with = ${tomlString(VENDORED_SOURCE)}`,
    "",
    `[source.${VENDORED_SOURCE}]`,
    `directory = ${tomlString(toolchain.vendor)}`,
    "",
    "[net]",
    "offline = true",
    "",
  ].join("\n");
  await writeFile(path.join(cargoHome, "config.toml"), config, { mode: 0o444 });
}

/** A TOML basic string. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The environment every command starts with, and nothing else (`env -i`): the toolchain's tools
 * first on PATH, the host-written homes, the build's own target folder and TMPDIR, the unsafe-code
 * policy, the store's clippy configuration and, for a Mac build, the SDK `xcrun` named.
 */
function buildEnv(plan: Plan): Record<string, string> {
  // A destination's settings go under the lane's own: none of them can move a home, a path or the policy.
  const env: Record<string, string> = {
    ...plan.settings?.env,
    PATH: [plan.toolchain.bin, ...SYSTEM_PATH].join(path.delimiter),
    HOME: `${plan.bin}${HOME_SUFFIX}`,
    CARGO_HOME: `${plan.bin}${CARGO_HOME_SUFFIX}`,
    CARGO_TARGET_DIR: path.join(plan.bin, TARGET_DIR),
    TMPDIR: path.join(plan.bin, TMP_DIR),
    RUSTFLAGS: [...rustTrustPolicy(plan.trust.trusted).rustflags, ...(plan.settings?.rustflags ?? [])].join(" "),
    CARGO_TERM_COLOR: "never",
    CLIPPY_CONF_DIR: plan.toolchain.clippyConf,
  };
  if (plan.sdk) env.SDKROOT = plan.sdk;
  // The facade opens its device with exactly these (`option_env!`); cargo rebuilds it when they change.
  if (plan.nativeFeatures.length) env[NATIVE_FEATURES_ENV] = plan.nativeFeatures.join(",");
  // The game's [render] and [[wgsl]] reach every destination, which has no game folder to read them from.
  if (plan.renderToml !== null) env[RENDER_TOML_ENV] = plan.renderToml;
  if (plan.wgslToml !== null) env[WGSL_TOML_ENV] = plan.wgslToml;
  // The relay client's build script downloads libcolyseus when no folder is named: every native build names one (MP-1a).
  Object.assign(env, colyseusBuildEnv(plan.toolchain.colyseus ?? null, plan.bin, plan.builder.triple));
  return env;
}

/** The security settings every cargo command carries as `--config` overrides, whatever a file says. */
function configArgs(plan: Plan, jobs: number): string[] {
  const settings = [
    `source.crates-io.replace-with=${tomlString(VENDORED_SOURCE)}`,
    `source.${VENDORED_SOURCE}.directory=${tomlString(plan.toolchain.vendor)}`,
    "net.offline=true",
    `build.rustc=${tomlString(path.join(plan.toolchain.bin, "rustc"))}`,
    'build.rustc-wrapper=""',
    `build.target-dir=${tomlString(path.join(plan.bin, TARGET_DIR))}`,
    `build.jobs=${jobs}`,
    'term.color="never"',
  ];
  return settings.flatMap((setting) => ["--config", setting]);
}

/** `env -i <env>`, quoted: what every command of a build starts through. */
function envPrefix(plan: Plan): string {
  const env = Object.entries(buildEnv(plan)).map(([name, value]) => `${name}=${value}`);
  return [ENV, "-i", ...env].map(shellQuote).join(" ");
}

/** `exec env -i <env> <program> <args>`: every word the host's, every one quoted. */
function command(plan: Plan, program: string, args: readonly string[]): string {
  return `exec ${envPrefix(plan)} ${[path.join(plan.toolchain.bin, program), ...args].map(shellQuote).join(" ")}`;
}

function rustcCommand(plan: Plan): string {
  return command(plan, "rustc", ["-vV"]);
}

function lockCommand(plan: Plan, lockDir: string): string {
  const manifest = path.join(lockDir, MANIFEST_FILE);
  return command(plan, "cargo", [
    "generate-lockfile",
    "--offline",
    "--manifest-path",
    manifest,
    ...configArgs(plan, 1),
  ]);
}

/** The cargo arguments clippy and the build share: offline, locked, the stage's manifest, the target and the profile. */
function sharedArgs(plan: Plan, jobs: number): string[] {
  const manifest = path.join(stageDir(plan.bin), MANIFEST_FILE);
  return [
    "--offline",
    "--locked",
    "--manifest-path",
    manifest,
    "--target",
    plan.settings?.front?.target ?? plan.builder.triple,
    "--message-format=json",
    ...configArgs(plan, jobs),
    ...profileArgs(plan),
  ];
}

/** Live's dev profile with optimized dependencies, cargo's release for an export, and a web export's size profile on top. */
function profileArgs(plan: Plan): string[] {
  const asConfig = (settings: readonly string[]) => settings.flatMap((setting) => ["--config", setting]);
  if (profileOf(plan.purpose) !== PROFILE.release) return asConfig(RUST_DEV_PROFILE_SETTINGS);
  const web = plan.target === BuildTarget.Web ? asConfig(RUST_WEB_EXPORT_PROFILE_SETTINGS) : [];
  const debug = plan.debug ? asConfig(EXPORT_DEBUG_SETTINGS[plan.debug.kind]) : [];
  return ["--release", ...web, ...debug];
}

/**
 * How an export keeps its debug files (CRASH-7a): by its destination's triple; null for Live and
 * judging builds, and for a kind that strips when the toolchain has no `llvm-objcopy` (that export
 * builds as before, keeping none).
 */
async function exportDebugOf(plan: Plan, compiler: RustCompilerIdentity): Promise<ExportDebug | null> {
  if (plan.purpose !== CppBuildPurpose.Export) return null;
  const kind = debugFileKind(plan.builder.triple);
  if (kind !== DebugFileKind.Unstripped) return { kind, objcopy: null };
  const objcopy = rustObjcopy(plan.toolchain.bin, compiler.host);
  return (await lstat(objcopy).catch(() => null))?.isFile() ? { kind, objcopy } : null;
}

/** What an export of `kind` keeps: the dSYM cargo uplifted beside `exe`, the unstripped `exe`, or the web symbol map. */
function debugSources(kind: DebugFileKind, exe: string, name: string, bin: string): DebugSource[] {
  if (kind === DebugFileKind.Dsym) return [{ from: `${exe}.dSYM`, as: `${name}.dSYM` }];
  if (kind === DebugFileKind.Unstripped) return [{ from: exe, as: name }];
  return [{ from: path.join(bin, DEBUG_STAGE_DIR, WEB_SYMBOL_MAP_FILE), as: WEB_SYMBOL_MAP_FILE }];
}

/** `cargo <step> <args>`, or the destination's front end's own subcommand for the step with the same arguments. */
function cargoStep(plan: Plan, step: "clippy" | "build", args: readonly string[]): string {
  const front = plan.settings?.front;
  if (!front) return command(plan, "cargo", [step, ...args]);
  return `exec ${envPrefix(plan)} ${[front.program, front[step], ...args].map(shellQuote).join(" ")}`;
}

function clippyCommand(plan: Plan, jobs: number): string {
  return cargoStep(plan, "clippy", [...sharedArgs(plan, jobs), "--", "-D", "warnings"]);
}

function buildCommand(plan: Plan, jobs: number): string {
  return cargoStep(plan, "build", sharedArgs(plan, jobs));
}

/**
 * What a step that printed no diagnostic said: from cargo's own `error:` line on (a linker's
 * failure, a resolution error), else its first lines, stderr first. Cargo's JSON messages and its
 * progress lines (`Compiling …`) are never the reason.
 */
function outputLinesOf(result: RunResult): string[] {
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !line.startsWith("{") && !CARGO_PROGRESS.test(line));
  const error = lines.findIndex((line) => CARGO_ERROR.test(line));
  return lines.slice(Math.max(0, error), Math.max(0, error) + PROBLEM_LINES);
}

/** One `[[package]]` of a Cargo.lock: what the lane checks. */
interface LockedPackage {
  name: string;
  version: string;
  source: string | null;
}

/** The packages of a Cargo.lock, read line by line (the host's own reader: cargo writes one key per line). */
function lockedPackages(text: string): LockedPackage[] {
  const packages: LockedPackage[] = [];
  let current: Partial<LockedPackage> | null = null;
  const flush = () => {
    if (current?.name && current.version)
      packages.push({ name: current.name, version: current.version, source: current.source ?? null });
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "[[package]]") {
      flush();
      current = {};
      continue;
    }
    // Any other table (an ejected game's `[[patch.unused]]`) is no package: its fields are not the last one's.
    if (line.startsWith("[")) {
      flush();
      current = null;
      continue;
    }
    const field = /^(name|version|source) = "([^"]*)"$/.exec(line);
    if (current && field?.[1] && field[2] !== undefined) current[field[1] as keyof LockedPackage] = field[2];
  }
  flush();
  return packages;
}

/**
 * The toolchain a build of a game with a crate grant uses: its directory source is the merged one
 * beside the build folder (`<bin>.vendor`), read together with the overlay's vendor folder; a game
 * with no grant builds on the store's set alone, as before.
 */
function withGrant(bin: string, toolchain: RustToolchain, grant: Extract<RustCrateGrant, { ok: true }>): RustToolchain {
  if (grant.vendor === null) return toolchain;
  const merged = `${bin}${VENDOR_SUFFIX}`;
  return { ...toolchain, vendor: merged, reads: [...toolchain.reads, merged, grant.vendor] };
}

/**
 * Why a generated lock is refused, or null: every package is a path package or the vendored
 * registry's, and vendored: in the store's set, or (the overlay's) granted to this game.
 */
async function lockRefusal(
  text: string,
  vendors: readonly string[],
  grant: Extract<RustCrateGrant, { ok: true }>,
): Promise<string | null> {
  const granted = new Set(grant.crates.map((crate) => `${crate.name}-${crate.version}`));
  for (const pkg of lockedPackages(text)) {
    if (pkg.source === null) continue;
    if (pkg.source !== CRATES_IO_SOURCE) return MESSAGE.lockSource(pkg.name, pkg.source);
    const [store, overlay] = vendors;
    const inStore = store !== undefined && (await vendoredIn(store, pkg));
    const inOverlay =
      overlay !== undefined && granted.has(`${pkg.name}-${pkg.version}`) && (await vendoredIn(overlay, pkg));
    if (!inStore && !inOverlay) return MESSAGE.lockVendor(pkg.name, pkg.version);
  }
  return null;
}

/** Whether `vendor` holds a real folder for `pkg` (`<name>-<version>`, or cargo's bare `<name>`). */
async function vendoredIn(vendor: string, pkg: { name: string; version: string }): Promise<boolean> {
  const found = await Promise.all(
    [`${pkg.name}-${pkg.version}`, pkg.name].map((dir) => lstat(path.join(vendor, dir)).catch(() => null)),
  );
  return found.some((info) => info?.isDirectory());
}

/** `exe` when it is a regular file inside the build folder by its real path, never through a link; else null. */
async function builtInside(bin: string, exe: string): Promise<string | null> {
  if (!path.isAbsolute(exe)) return null;
  const found = await lstat(exe).catch(() => null);
  if (!found?.isFile() || found.size > EXECUTABLE_MAX_BYTES) return null;
  const [realBin, realExe] = await Promise.all([realpath(bin).catch(() => null), realpath(exe).catch(() => null)]);
  return realBin && realExe && isInside(realBin, realExe) && realExe !== realBin ? realExe : null;
}

/** What the stage read from `genex.toml`, taken into the plan: each field absent from the stage is its default. */
function adoptStaged(plan: Plan, staged: Extract<RustStaged, { ok: true }>): void {
  plan.title = staged.title ?? plan.game.project;
  plan.nativeFeatures = staged.nativeFeatures ?? [];
  plan.renderToml = staged.renderToml ?? null;
  plan.wgslToml = staged.wgslToml ?? null;
  plan.wasmBudgetMb = staged.wasmBudgetMb ?? null;
  plan.loading = staged.loading ?? null;
  plan.assetGroups = staged.assetGroups ?? [];
  plan.assetBudgets = staged.assets ?? null;
}

/** What writing `<bin>.out` came to: the admitted files and the package, or the admission's refusal (nothing replaced). */
type WrittenOutput =
  | { ok: true; outputs: RustBuildReceipt["outputs"]; package: AssetPackageReport | null }
  | { ok: false; refused: Extract<RustOutputAdmission, { ok: false }> }
  | { ok: false; packageRefused: string };

/**
 * Writes `<bin>.out` afresh: the executable under each of the builder's names (for the web, the
 * regular files the web branch packaged in `web` instead) and the destination's package of the
 * staged assets (`packageAssets`, C-15: its families, the asset index), regular files only; `admit` (the host's admission) reads that fresh folder before anything replaces the last
 * good one, and a refusal leaves the old `out/` in place. Then swaps it into place and records
 * every file's digest in `<bin>.admitted`. Answers the admitted files.
 */
async function writeOutput(
  plan: Plan,
  exe: string,
  web: string | null,
  admit: RustOutputAdmit | undefined,
): Promise<WrittenOutput> {
  const out = `${plan.bin}${OUT_SUFFIX}`;
  const fresh = `${out}.new`;
  await rm(fresh, { recursive: true, force: true });
  await mkdir(fresh);
  if (web) await copyRegularFiles(web, fresh);
  else await copyExecutables(plan, exe, fresh);
  const pack = plan.builder.assets
    ? await packageAssets({
        from: path.join(stageDir(plan.bin), ASSETS_DIR),
        to: path.join(fresh, ASSETS_DIR),
        target: plan.target,
        lock: await trustedLockRows(plan.source),
        imported: plan.assets,
        groups: plan.assetGroups,
        budget: assetBudgetOf(plan.assetBudgets, plan.target),
        ...(plan.assetBudgets?.phoneMaxTexturePx ? { textureCapPx: plan.assetBudgets.phoneMaxTexturePx } : {}),
      })
    : null;
  // Past the destination's hard cap (the web shell's 512 MB) the build is refused; past its budget it only warns.
  const overCeiling = pack ? packageCeilingRefusal(pack) : null;
  if (overCeiling) {
    await rm(fresh, { recursive: true, force: true });
    return { ok: false, packageRefused: overCeiling };
  }
  // A browser cannot list `assets/`: the page fetches by this map, and the module checks each file.
  if (web) await writeWebAssetMap(fresh);
  const servesStudio = rustFlavourOf(plan.purpose, plan.target) === RustFlavour.Dev;
  const admitted = admit ? await admit(fresh, plan.target, { servesStudio }) : null;
  if (admitted && !admitted.ok) {
    await rm(fresh, { recursive: true, force: true });
    return { ok: false, refused: admitted };
  }
  const outputs = await digestTree(fresh);
  await rm(`${plan.bin}${ADMITTED_SUFFIX}`, { force: true });
  const old = `${out}.old`;
  await rm(old, { recursive: true, force: true });
  await rename(out, old).catch(() => {});
  await rename(fresh, out);
  await rm(old, { recursive: true, force: true });
  await atomicWriteText(`${plan.bin}${ADMITTED_SUFFIX}`, `${JSON.stringify(outputs)}\n`);
  return { ok: true, outputs, package: pack };
}

/** The rows of the game's `genex-assets.lock` when it reads as trusted (the index's ids); null otherwise. */
async function trustedLockRows(gameDir: string): Promise<AssetLockEntry[] | null> {
  const lock = await readAssetLock(gameDir).catch(() => null);
  return lock?.state === AssetLockState.Trusted ? lock.entries : null;
}

/**
 * The executable under each of the builder's names. A clone where the file system makes one (APFS):
 * a file of its own, which a later write to cargo's copy never reaches, made without copying the
 * bytes; elsewhere a plain copy.
 */
async function copyExecutables(plan: Plan, exe: string, to: string): Promise<void> {
  for (const name of plan.builder.executables) {
    await copyFile(exe, path.join(to, name), FS_CONSTANTS.COPYFILE_FICLONE);
    await chmod(path.join(to, name), 0o755);
  }
}

/** The regular files directly in `from` (links, folders and anything else left out), copied into `to`. */
async function copyRegularFiles(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile()) await copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
}

/** The stage's `engine/` (an ejected game's fork) copied into `to`, regular files and folders only; nothing when the stage has none. */
async function copyStagedEngine(stage: string, to: string): Promise<void> {
  const engine = path.join(stage, RUST_ENGINE_FOLDER);
  const found = await lstat(engine).catch(() => null);
  if (found?.isDirectory()) await copyRegularTree(engine, path.join(to, RUST_ENGINE_FOLDER));
}

/** Copies the regular files and folders under `from` into `to` (made); links and anything else are left out. */
async function copyRegularTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true }).catch(() => [])) {
    const source = path.join(from, entry.name);
    if (entry.isDirectory()) await copyRegularTree(source, path.join(to, entry.name));
    else if (entry.isFile()) await copyFile(source, path.join(to, entry.name));
  }
}

/** Every regular file under `dir`, `/`-separated, with its sha256 and size, sorted. */
async function digestTree(dir: string, rel = ""): Promise<RustBuildReceipt["outputs"]> {
  const files: RustBuildReceipt["outputs"] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await digestTree(dir, child)));
    else if (entry.isFile()) {
      const bytes = await readRegularFile(path.join(dir, child), EXECUTABLE_MAX_BYTES);
      files.push({ path: toPosixRelative(child), sha256: sha256(bytes), bytes: bytes.length });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `<bin>.out` when it is exactly what was admitted: the same files, each a regular file with its
 * recorded digest, and nothing else. Anything changed since is no output.
 */
export async function lastAdmitted(bin: string): Promise<string | null> {
  const out = `${bin}${OUT_SUFFIX}`;
  const recorded = await readRegularFile(`${bin}${ADMITTED_SUFFIX}`, STAMP_MAX_BYTES).catch(() => null);
  if (!recorded || !(await lstat(out).catch(() => null))?.isDirectory()) return null;
  try {
    const expected = JSON.parse(recorded.toString("utf8")) as RustBuildReceipt["outputs"];
    const actual = await digestTree(out);
    return JSON.stringify(actual) === JSON.stringify(expected) ? out : null;
  } catch {
    return null;
  }
}

/** `dir` emptied and made afresh as a real folder (a link at its name is removed, never followed). */
async function freshFolder(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir);
}

/**
 * `dir` as a real folder, made unless it already is one. A link or a file at its name, put there
 * by a process that can write its parent, is removed first (a link itself, never what it points at).
 */
async function ownFolder(dir: string): Promise<void> {
  const found = await lstat(dir).catch(() => null);
  if (found?.isDirectory()) return;
  if (found) await rm(dir, { recursive: true, force: true });
  await mkdir(dir).catch(async (error: NodeJS.ErrnoException) => {
    const made = error.code === "EEXIST" ? await lstat(dir).catch(() => null) : null;
    if (!made?.isDirectory()) throw error;
  });
}

/** Whether `root` and every folder from it down to `target` is a real folder, never a link. */
async function realFolders(root: string, target: string): Promise<boolean> {
  if (!isInside(root, target)) return false;
  const rel = path.relative(root, target);
  let current = root;
  for (const name of ["", ...(rel ? rel.split(path.sep) : [])]) {
    current = path.join(current, name);
    if (!(await lstat(current).catch(() => null))?.isDirectory()) return false;
  }
  return true;
}

/**
 * One project's folder: each build folder of a lock `keep` does not name, or whose source root is
 * gone or unknown, goes with everything named after it beside it; an empty project folder goes too.
 * With `keep` unknown (null), no folder goes for its lock alone.
 */
async function sweepProject(project: string, keep: ReadonlySet<string> | null): Promise<number> {
  let removed = 0;
  const names = await readdir(project).catch(() => [] as string[]);
  for (const name of names) {
    const digest = BUILD_FOLDER.exec(name)?.[2];
    if (!digest) continue;
    const oldLock = keep !== null && !keep.has(digest);
    if (!oldLock && (await sourceIsThere(path.join(project, name)))) continue;
    for (const other of names)
      if (other === name || other.startsWith(`${name}.`))
        await rm(path.join(project, other), { recursive: true, force: true });
    removed++;
  }
  await rmdir(project).catch(() => {});
  return removed;
}

/** Whether the source root a build folder was made for is still there, read from the host's stamp beside it. */
async function sourceIsThere(bin: string): Promise<boolean> {
  if (!(await lstat(bin).catch(() => null))?.isDirectory()) return false;
  const source = await readRegularFile(`${bin}${SOURCE_SUFFIX}`, STAMP_MAX_BYTES).catch(() => null);
  if (!source?.length) return false;
  return (await lstat(source.toString("utf8")).catch(() => null)) !== null;
}
