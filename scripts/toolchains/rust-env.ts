/**
 * The cargo env helper: runs a cargo command over the `genex` workspace, or a tool the pinned Rust
 * toolchain folder installed, with that toolchain only. Promoted from the M0a spike's
 * `scripts/spike/rust-wgpu/rust-env.sh` (which stays for the spike scripts that source it).
 *
 *   node scripts/toolchains/rust-env.ts -- cargo test --workspace --offline --locked
 *   node scripts/toolchains/rust-env.ts -- cargo clippy --workspace --offline --locked -- -D warnings
 *   node scripts/toolchains/rust-env.ts -- wasm-bindgen --version
 *   eval "$(node scripts/toolchains/rust-env.ts --print-env)"
 *
 * - The toolchain is the spike folder `.studio-dev/spike-toolchain/` that
 *   `scripts/spike/rust-wgpu/setup-toolchain.sh` installs from the pins in
 *   `scripts/spike/rust-wgpu/pins.md`: a developer's helper. The app locates its own toolchain
 *   in the store (`rust-locate.ts`); `GENEX_RUST_TOOLCHAIN_DIR` names another folder of this layout.
 * - Before anything runs, every archive the toolchain's receipt lists must be pinned with the same
 *   sha256, the sysroot's tools must resolve inside the toolchain folder and the vendored
 *   `CARGO_HOME` and crate tree must be present. Without an installed toolchain the refusal names
 *   the pinned archives the host's sysroot is installed from.
 * - The sysroot's bin comes first on PATH; `~/.cargo/bin`, rustup's folders and any folder holding
 *   a `rustup` are dropped, `RUSTUP_*` are unset and the rustc wrappers are set empty (which also
 *   overrides a config file's): rustup and `~/.cargo` are never consulted. Inherited compiler flags
 *   (`RUSTFLAGS` and kin) and every inherited `CARGO_*` but the target folder and terminal output
 *   are dropped: cargo reads them as configuration, which is the helper's alone.
 * - Every cargo subcommand that takes one gets `--manifest-path native/genex-rust/Cargo.toml`
 *   right after it, never the repository root; a caller's own `--manifest-path`, `+toolchain`,
 *   `--config` or `-Z` is refused (each could pick another workspace, toolchain, wrapper or source),
 *   and so is a `.cargo/config[.toml]` in the working folder, the workspace or a folder above them.
 * - `cargo test` and `cargo bench` run with `GENEX_NO_WINDOW=1`, so a test that reaches the desktop
 *   shell's window is refused `window-refused` instead of opening one; a caller's explicit
 *   `GENEX_NO_WINDOW=0` (the owner's windowed smoke rows) is kept.
 * - The cross-compiler env (Android NDK, llvm-mingw, iOS deployment target, JAVA_HOME) is set for
 *   whatever is installed. `CARGO_TARGET_DIR` defaults to `.studio-dev/cargo-target`.
 *
 * - `cargo clean` is refused `target-in-use` while a cargo, a rustc or clippy, or a program run
 *   from the target folder runs on this machine: deleting the shared target under a build or a test
 *   binary fails that run. `GENEX_CARGO_CLEAN_BUSY=1` cleans anyway (the owner's call).
 *
 * A refusal is one line on stderr, `genex-rust-env-refusal: {"code":…,"detail":…}`, and exit 78;
 * nothing starts and nothing is written. Otherwise the exit code is the tool's.
 *
 * Overrides (tests and other worktrees): GENEX_RUST_TOOLCHAIN_DIR, GENEX_RUST_PINS,
 * GENEX_RUST_WORKSPACE.
 */
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../../src/substrate/shell-quote.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_VERSION = "1.99.0";
/** The exit code of a refusal (EX_CONFIG), the spike helper's too. */
export const RUST_ENV_REFUSAL_EXIT = 78;
const REFUSAL_PREFIX = "genex-rust-env-refusal: ";
const IOS_DEPLOYMENT_TARGET = "16.0";
const ANDROID_API = 29;
/** The plan pins NDK r30; the installed 27.x is used without new licences (recorded deviation). */
const NDK_VERSIONS = ["30.0.16248370", "27.1.12297006", "27.0.12077973"] as const;
const SYSROOT_TOOLS = ["cargo", "rustc", "rustdoc", "cargo-clippy", "clippy-driver"] as const;
/** Cargo subcommands that take --manifest-path (cargo-zigbuild, cargo-deny and cargo-vet included). */
const MANIFEST_SUBCOMMANDS: ReadonlySet<string> = new Set(
  "build b check c test t clippy run r doc d bench metadata tree fetch vendor update generate-lockfile rustc rustdoc clean package pkgid locate-project verify-project fix fmt zigbuild deny vet".split(
    " ",
  ),
);
/** Cargo subcommands that run test or bench binaries: they never get a window. */
const NO_WINDOW_SUBCOMMANDS = new Set(["test", "t", "bench"]);
/** The desktop shell's marker that forbids a window (`genex-platform-desktop` `NO_WINDOW_ENV`). */
const NO_WINDOW_ENV = "GENEX_NO_WINDOW";
const NO_WINDOW_ON = "1";
/** A caller's explicit opt-out, for the owner's windowed smoke rows. */
const NO_WINDOW_OPT_OUT = "0";

/**
 * The folder the vendored relay client's build script (genex-multiplayer `build.rs`) links
 * libcolyseus from. Unset, that script downloads the Colyseus xcframework on a Mac, so the helper
 * always names one: the toolchain's `tools/colyseus/<triple>`, or the caller's own folder.
 */
const COLYSEUS_LIB_DIR_ENV = "GENEX_COLYSEUS_LIB_DIR";
/** The archive that build script reads only on its download path: never passed on. */
const COLYSEUS_ARCHIVE_ENV = "GENEX_COLYSEUS_ARCHIVE";

/** Cargo tools whose first word after the subcommand is a command of their own, ahead of `--manifest-path`. */
const NESTED_COMMAND_TOOLS: ReadonlySet<string> = new Set(["vet"]);
/** Global cargo options that consume the next argument. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(["--config", "-C", "--color", "-Z", "--explain"]);
/** `--target` spellings that name no extra standard library. */
const HOST_TARGETS: ReadonlySet<string> = new Set(["all", "host", "host-tuple"]);
/** A target triple, optionally with a glibc floor (`x86_64-unknown-linux-gnu.2.28`). */
const TARGET_TRIPLE = /^[a-z0-9_]+(?:-[a-z0-9_]+){1,3}(?:\.[0-9]+(?:\.[0-9]+)*)?$/;
const PINS_BEGIN = "<!-- genex-spike-pins:begin -->";
const PINS_END = "<!-- genex-spike-pins:end -->";
const SYSROOT_GROUP = "rust";
const CARGO_CONFIG_FILES = ["config", "config.toml"] as const;
/** Signals passed on to the running tool, so Ctrl-C and Stop reach cargo. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const PRINTED_ENV = [
  "PATH",
  "CARGO_HOME",
  "CARGO",
  "RUSTC",
  "RUSTDOC",
  "CARGO_TARGET_DIR",
  "CARGO_NET_OFFLINE",
  "IPHONEOS_DEPLOYMENT_TARGET",
  "ANDROID_NDK_HOME",
  "ANDROID_NDK_ROOT",
  "CC_aarch64_linux_android",
  "CXX_aarch64_linux_android",
  "AR_aarch64_linux_android",
  "CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER",
  "CC_x86_64_pc_windows_gnullvm",
  "CXX_x86_64_pc_windows_gnullvm",
  "AR_x86_64_pc_windows_gnullvm",
  "CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER",
  "JAVA_HOME",
  "GENEX_COLYSEUS_LIB_DIR",
] as const;
const WRAPPER_VARIABLES = [
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
] as const;
const UNSET_VARIABLES = ["RUSTUP_TOOLCHAIN", "RUSTUP_HOME", "CARGO_BUILD_RUSTC"] as const;
/**
 * Compiler flags cargo and rustc read from the environment: each can name a linker or a plugin
 * (`-Clinker=…`), so none is inherited, as no `--config` is.
 */
const FLAG_VARIABLES = [
  "RUSTFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
  "RUSTDOCFLAGS",
  "CARGO_ENCODED_RUSTDOCFLAGS",
  "RUSTC_BOOTSTRAP",
] as const;
/**
 * The `CARGO_*` variables a caller may set: the target folder and how cargo prints. Cargo reads
 * every other `CARGO_*` as configuration (a source replacement, a registry, a target's runner or
 * linker, `build.rustflags`), which the helper fixes; those are dropped, and the helper sets its
 * own after.
 */
const CALLER_CARGO_VARIABLE = /^CARGO_(?:TARGET_DIR|TERM_[A-Z_]+|INCREMENTAL)$/;

/** Why the helper refused to run. Wire values: scripts and tests match them. */
export const RustEnvRefusal = {
  Usage: "usage",
  PinsMissing: "pins-missing",
  ToolchainMissing: "toolchain-missing",
  ToolMissing: "tool-missing",
  ToolOutsideToolchain: "tool-outside-toolchain",
  VendorMissing: "vendor-missing",
  ArchiveNotApproved: "archive-not-approved",
  ArchiveSha256Mismatch: "archive-sha256-mismatch",
  RustupToolchain: "rustup-toolchain",
  ManifestOverride: "manifest-override",
  ConfigOverride: "config-override",
  CargoConfigFound: "cargo-config-found",
  /** `cargo clean` while a build or a test binary uses the target folder. */
  TargetInUse: "target-in-use",
} as const;
export type RustEnvRefusal = (typeof RustEnvRefusal)[keyof typeof RustEnvRefusal];

const MESSAGE = {
  Usage: "usage: rust-env.ts [--] cargo <args…> | rust-env.ts [--] <toolchain tool> <args…> | rust-env.ts --print-env",
  PinsMissing: (file: string) => `no pins file at ${file}`,
  ToolchainMissing: (dir: string, archives: readonly string[]) =>
    `no Rust toolchain installed at ${dir}: run scripts/spike/rust-wgpu/setup-toolchain.sh, which installs the pinned ${archives.join(", ")}`,
  NotApproved: (file: string) => `${file} is installed but not pinned`,
  Mismatch: (file: string, installed: string, pinned: string) => `${file}: installed ${installed}, pinned ${pinned}`,
  ToolAbsent: (file: string) => `${path.basename(file)} is not installed at ${file}`,
  NotExecutable: (file: string) => `${file} is not executable`,
  Outside: (file: string) => `${file} resolves outside the toolchain folder`,
  VendorConfig: (file: string) => `no vendored CARGO_HOME config at ${file}`,
  VendorTree: (dir: string) => `no vendored crates at ${dir}: run setup-toolchain.sh`,
  NotTriple: (target: string) => `--target ${target} is not a target triple`,
  NoStd: (std: string, sysroot: string) => `rust-std for ${std} is not installed in ${sysroot}`,
  NoNdk: (target: string) =>
    `no Android NDK clang for ${target} (ANDROID_NDK_HOME or the SDK's ndk/<${NDK_VERSIONS.join("|")}>)`,
  NoMingw: (dir: string) => `llvm-mingw is not installed in ${dir} (setup-toolchain.sh --with mingw)`,
  Rustup: (arg: string) => `cargo ${arg}: the pinned sysroot is the only toolchain`,
  Manifest: (manifest: string) => `cargo always builds ${manifest}`,
  Config: (arg: string) => `cargo ${arg}: the cargo configuration is fixed`,
  CargoConfig: (file: string) => `cargo would read ${file}: these builds take no cargo config`,
  ToolNotInstalled: (tool: string, dir: string) => `${tool} is not installed in the toolchain folder ${dir}`,
  TargetInUse: (dir: string, line: string) =>
    `cargo clean would delete ${dir} under a running build or test (${line}); wait for it, or set ${CLEAN_BUSY_ENV}=1`,
} as const;

/** Programs that build into a cargo target folder. */
const BUILDING_TOOLS: ReadonlySet<string> = new Set(["cargo", "rustc", "rustdoc", "clippy-driver", "cargo-clippy"]);
/** The owner's override: clean the target although something uses it. */
const CLEAN_BUSY_ENV = "GENEX_CARGO_CLEAN_BUSY";
/** How much of a busy process's command line a refusal names. */
const BUSY_LINE_MAX_CHARS = 160;

/**
 * For `cargo clean` (not its `--dry-run`): the first of `processes` (`ps -Ao pid=,command=` lines)
 * other than `selfPid` that builds (cargo, rustc, rustdoc, clippy) or runs a program from `target`,
 * else null. Null for any other subcommand.
 */
export function cleanWhileBuilding(
  args: readonly string[],
  processes: readonly string[],
  target: string,
  selfPid: number,
): string | null {
  const at = subcommandIndex(args);
  if (at < 0 || args[at] !== "clean" || args.includes("--dry-run")) return null;
  const inTarget = `${target.replace(/\/+$/, "")}/`;
  const busy = (line: string) => {
    const [pid = "", program = ""] = line.trim().split(/\s+/);
    if (Number(pid) === selfPid) return false;
    return BUILDING_TOOLS.has(path.basename(program)) || program.startsWith(inTarget);
  };
  return processes.find(busy) ?? null;
}

/** Refuses `cargo clean` while the target is in use, unless the owner set the override. */
function checkCleanQuiet(args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (env[CLEAN_BUSY_ENV] === "1") return;
  const target = env.CARGO_TARGET_DIR ?? "";
  const listed = () => execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" }).split("\n");
  const at = subcommandIndex(args);
  if (at < 0 || args[at] !== "clean") return;
  const busy = cleanWhileBuilding(args, listed(), target, process.pid);
  if (busy)
    throw new Refused(
      RustEnvRefusal.TargetInUse,
      MESSAGE.TargetInUse(target, busy.trim().slice(0, BUSY_LINE_MAX_CHARS)),
    );
}

/** A refusal on its way to the one typed stderr line. */
class Refused extends Error {
  readonly code: RustEnvRefusal;
  readonly archives: readonly string[] | undefined;
  constructor(code: RustEnvRefusal, detail: string, archives?: readonly string[]) {
    super(detail);
    this.code = code;
    this.archives = archives;
  }
}

/** Where the pinned toolchain, its pins and the workspace are. */
export interface RustToolchainLayout {
  dir: string;
  sysroot: string;
  cargoHome: string;
  vendor: string;
  tools: string;
  receipt: string;
  pins: string;
  workspace: string;
}

/** One pinned archive. */
interface Pin {
  group: string;
  file: string;
  url: string;
  sha256: string;
}

/** The toolchain the helper runs with: the spike folder, or `GENEX_RUST_TOOLCHAIN_DIR`. */
export function rustToolchainLayout(env: NodeJS.ProcessEnv = process.env): RustToolchainLayout {
  const dir = env.GENEX_RUST_TOOLCHAIN_DIR || path.join(REPO, ".studio-dev", "spike-toolchain");
  return {
    dir,
    sysroot: path.join(dir, "sysroot"),
    cargoHome: path.join(dir, "cargo-home"),
    vendor: path.join(dir, "vendor"),
    tools: path.join(dir, "tools"),
    receipt: path.join(dir, "receipt.tsv"),
    pins: env.GENEX_RUST_PINS || path.join(REPO, "scripts", "spike", "rust-wgpu", "pins.md"),
    workspace: env.GENEX_RUST_WORKSPACE || path.join(REPO, "native", "genex-rust"),
  };
}

/** The file each pinned archive URL was saved as in `downloads/` (the pins table's `file` column). */
export function pinnedDownloadNames(layout: RustToolchainLayout = rustToolchainLayout()): Map<string, string> {
  return new Map(readPins(layout.pins).map((pin) => [pin.url, pin.file]));
}

/** The host's Rust triple, as the sysroot archives spell it. */
function hostTriple(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return process.platform === "darwin" ? `${arch}-apple-darwin` : `${arch}-unknown-linux-gnu`;
}

const trimmedCells = (line: string) => line.split("|").map((cell) => cell.trim());

/** The rows of the pins table, in file order. */
function readPins(file: string): Pin[] {
  if (!existsSync(file)) throw new Refused(RustEnvRefusal.PinsMissing, MESSAGE.PinsMissing(file));
  const lines = readFileSync(file, "utf8").split("\n");
  const begin = lines.findIndex((line) => line.startsWith(PINS_BEGIN));
  const end = lines.findIndex((line) => line.startsWith(PINS_END));
  if (begin < 0 || end < begin) return [];
  return lines
    .slice(begin + 1, end)
    .filter((line) => line.startsWith("|"))
    .map(trimmedCells)
    .filter((cells) => cells.length >= 6 && cells[2] !== "file" && !/^-+$/.test(cells[2]))
    .map((cells) => ({ group: cells[1], file: cells[2], url: cells[3], sha256: cells[4] }));
}

/** The pinned archives the host's sysroot is installed from. */
export function sysrootArchives(pins: readonly Pin[], triple = hostTriple()): string[] {
  const suffix = `-${RUST_VERSION}-${triple}.tar.xz`;
  return pins.filter((pin) => pin.group === SYSROOT_GROUP && pin.file.endsWith(suffix)).map((pin) => pin.file);
}

/** Every archive the receipt lists must be pinned with the same sha256. */
function checkReceipt(layout: RustToolchainLayout, pins: readonly Pin[]): void {
  const pinned = new Map(pins.map((pin) => [pin.file, pin.sha256]));
  const rows = readFileSync(layout.receipt, "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cells) => cells.length >= 3);
  for (const [, file, sha256] of rows) {
    const approved = pinned.get(file);
    if (approved === undefined) throw new Refused(RustEnvRefusal.ArchiveNotApproved, MESSAGE.NotApproved(file));
    if (approved !== sha256) {
      throw new Refused(RustEnvRefusal.ArchiveSha256Mismatch, MESSAGE.Mismatch(file, sha256, approved));
    }
  }
}

const realOrNull = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/** Whether `file`, every link followed, lies inside the toolchain folder. */
function insideToolchain(layout: RustToolchainLayout, file: string): boolean {
  const real = realOrNull(file);
  const root = realOrNull(layout.dir);
  return real !== null && root !== null && real.startsWith(`${root}${path.sep}`);
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function checkTool(layout: RustToolchainLayout, file: string): void {
  if (!existsSync(file)) throw new Refused(RustEnvRefusal.ToolMissing, MESSAGE.ToolAbsent(file));
  if (!insideToolchain(layout, file)) throw new Refused(RustEnvRefusal.ToolOutsideToolchain, MESSAGE.Outside(file));
  if (!isExecutable(file)) throw new Refused(RustEnvRefusal.ToolMissing, MESSAGE.NotExecutable(file));
}

const nonEmptyFolder = (dir: string) => existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;

/** The installed toolchain matches its pins, holds the sysroot's tools and the vendored registry. */
export function checkToolchain(layout: RustToolchainLayout): void {
  const pins = readPins(layout.pins);
  if (!existsSync(layout.dir) || !existsSync(layout.receipt)) {
    const archives = sysrootArchives(pins);
    throw new Refused(RustEnvRefusal.ToolchainMissing, MESSAGE.ToolchainMissing(layout.dir, archives), archives);
  }
  checkReceipt(layout, pins);
  for (const tool of SYSROOT_TOOLS) checkTool(layout, path.join(layout.sysroot, "bin", tool));
  const config = path.join(layout.cargoHome, "config.toml");
  if (!existsSync(config)) throw new Refused(RustEnvRefusal.VendorMissing, MESSAGE.VendorConfig(config));
  if (!nonEmptyFolder(layout.vendor))
    throw new Refused(RustEnvRefusal.VendorMissing, MESSAGE.VendorTree(layout.vendor));
}

/** The installed Android NDK: ANDROID_NDK_HOME, else a known version under the SDK. */
function androidNdk(env: NodeJS.ProcessEnv): string | null {
  if (env.ANDROID_NDK_HOME && existsSync(env.ANDROID_NDK_HOME)) return env.ANDROID_NDK_HOME;
  const sdk = env.ANDROID_HOME || path.join(env.HOME ?? "", "Library", "Android", "sdk");
  const found = NDK_VERSIONS.map((version) => path.join(sdk, "ndk", version)).find((dir) => existsSync(dir));
  return found ?? null;
}

function ndkBin(env: NodeJS.ProcessEnv): string | null {
  const ndk = androidNdk(env);
  const host = process.platform === "linux" ? "linux-x86_64" : "darwin-x86_64";
  return ndk ? path.join(ndk, "toolchains", "llvm", "prebuilt", host, "bin") : null;
}

const mingwFolder = (layout: RustToolchainLayout) => path.join(layout.tools, "llvm-mingw");
const androidClang = (bin: string) => path.join(bin, `aarch64-linux-android${ANDROID_API}-clang`);
const mingwClang = (layout: RustToolchainLayout) => path.join(mingwFolder(layout), "bin", "x86_64-w64-mingw32-clang");

/** Whether a PATH folder could hand out rustup's or ~/.cargo's cargo. */
function isRustupFolder(dir: string, env: NodeJS.ProcessEnv): boolean {
  const home = env.HOME ?? "";
  const cargoBins = [path.join(home, ".cargo", "bin"), path.join(env.CARGO_HOME || path.join(home, ".cargo"), "bin")];
  const rustupPart = dir.endsWith(`${path.sep}.rustup`) || dir.includes(`${path.sep}.rustup${path.sep}`);
  return cargoBins.includes(dir) || rustupPart || isExecutable(path.join(dir, "rustup"));
}

/** PATH without ~/.cargo/bin, rustup folders or any folder that holds a rustup. */
function filteredPath(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "" && !isRustupFolder(dir, env));
}

function crossEnv(layout: RustToolchainLayout, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const bin = ndkBin(env);
  if (bin && existsSync(bin)) {
    const ndk = bin.slice(0, bin.indexOf(`${path.sep}toolchains${path.sep}`));
    Object.assign(out, {
      ANDROID_NDK_HOME: ndk,
      ANDROID_NDK_ROOT: ndk,
      CC_aarch64_linux_android: androidClang(bin),
      CXX_aarch64_linux_android: `${androidClang(bin)}++`,
      AR_aarch64_linux_android: path.join(bin, "llvm-ar"),
      CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: androidClang(bin),
    });
  }
  const mingwBin = path.join(mingwFolder(layout), "bin");
  if (existsSync(mingwBin)) {
    Object.assign(out, {
      CC_x86_64_pc_windows_gnullvm: mingwClang(layout),
      CXX_x86_64_pc_windows_gnullvm: `${mingwClang(layout)}++`,
      AR_x86_64_pc_windows_gnullvm: path.join(mingwBin, "llvm-ar"),
      CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER: mingwClang(layout),
    });
  }
  const jdk = [path.join(layout.tools, "jdk", "Contents", "Home"), path.join(layout.tools, "jdk")].find((home) =>
    existsSync(path.join(home, "bin")),
  );
  if (jdk) out.JAVA_HOME = jdk;
  return out;
}

/** The environment every tool runs with: the pinned sysroot first, no rustup, the vendored CARGO_HOME. */
export function rustEnvironment(layout: RustToolchainLayout, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extras = ["bin", "zig", path.join("binaryen", "bin")]
    .map((rel) => path.join(layout.tools, rel))
    .filter((dir) => existsSync(dir));
  const bin = path.join(layout.sysroot, "bin");
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of UNSET_VARIABLES) delete out[name];
  for (const name of FLAG_VARIABLES) delete out[name];
  delete out[COLYSEUS_ARCHIVE_ENV];
  for (const name of Object.keys(out)) {
    if (name.startsWith("CARGO_") && !CALLER_CARGO_VARIABLE.test(name)) delete out[name];
  }
  // Empty, not unset: an empty wrapper variable also overrides `build.rustc-wrapper` in a config.
  for (const name of WRAPPER_VARIABLES) out[name] = "";
  return {
    ...out,
    PATH: [bin, ...extras, ...filteredPath(env)].join(path.delimiter),
    CARGO_HOME: layout.cargoHome,
    CARGO: path.join(bin, "cargo"),
    RUSTC: path.join(bin, "rustc"),
    RUSTDOC: path.join(bin, "rustdoc"),
    CARGO_TARGET_DIR: env.CARGO_TARGET_DIR || path.join(REPO, ".studio-dev", "cargo-target"),
    CARGO_NET_OFFLINE: "true",
    IPHONEOS_DEPLOYMENT_TARGET: env.IPHONEOS_DEPLOYMENT_TARGET || IOS_DEPLOYMENT_TARGET,
    [COLYSEUS_LIB_DIR_ENV]: env[COLYSEUS_LIB_DIR_ENV] || colyseusLibDir(layout, hostTriple()),
    ...crossEnv(layout, env),
  };
}

/** The toolchain's libcolyseus folder for `triple` (a glibc floor dropped): `tools/colyseus/<triple>`. */
export function colyseusLibDir(layout: RustToolchainLayout, triple: string): string {
  return path.join(layout.tools, "colyseus", triple.replace(/-gnu\..*$/, "-gnu"));
}

/** The first `--target` before `--`, or null for the host (none, or `host`, `all`, `host-tuple`). */
function firstTarget(args: readonly string[]): string | null {
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  const at = own.findIndex((arg) => arg === "--target" || arg.startsWith("--target="));
  if (at < 0) return null;
  const target = own[at] === "--target" ? (own[at + 1] ?? "") : own[at].slice("--target=".length);
  return HOST_TARGETS.has(target) ? null : target;
}

/**
 * `env` with the libcolyseus folder of the triple cargo builds for `args` (the first `--target`, else
 * the host's), unless the caller named a folder of its own in `caller`. One folder per run: a run
 * naming several targets links the first one's.
 */
export function colyseusEnvironment(
  layout: RustToolchainLayout,
  caller: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): NodeJS.ProcessEnv {
  if (caller[COLYSEUS_LIB_DIR_ENV]) return env;
  const target = firstTarget(args);
  return target === null ? env : { ...env, [COLYSEUS_LIB_DIR_ENV]: colyseusLibDir(layout, target) };
}

/** A `--target` needs its rust-std in the sysroot and, for some targets, a cross linker. */
function checkTarget(layout: RustToolchainLayout, target: string, env: NodeJS.ProcessEnv): void {
  if (HOST_TARGETS.has(target)) return;
  if (!TARGET_TRIPLE.test(target)) throw new Refused(RustEnvRefusal.ToolMissing, MESSAGE.NotTriple(target));
  const std = target.replace(/-gnu\..*$/, "-gnu");
  if (!existsSync(path.join(layout.sysroot, "lib", "rustlib", std, "lib"))) {
    throw new Refused(RustEnvRefusal.ToolMissing, MESSAGE.NoStd(std, layout.sysroot));
  }
  const bin = ndkBin(env);
  if (std === "aarch64-linux-android" && !(bin && isExecutable(androidClang(bin)))) {
    throw new Refused(RustEnvRefusal.ToolMissing, MESSAGE.NoNdk(target));
  }
  if (std === "x86_64-pc-windows-gnullvm" && !isExecutable(mingwClang(layout))) {
    throw new Refused(RustEnvRefusal.ToolMissing, MESSAGE.NoMingw(mingwFolder(layout)));
  }
}

/** Refuse a cargo config file cargo would read: in `.cargo/` of the working folder, the workspace or above. */
function checkCargoConfigs(layout: RustToolchainLayout, cwd: string): void {
  for (const start of [cwd, layout.workspace]) {
    let dir = realOrNull(start);
    while (dir !== null) {
      for (const name of CARGO_CONFIG_FILES) {
        const file = path.join(dir, ".cargo", name);
        if (existsSync(file)) throw new Refused(RustEnvRefusal.CargoConfigFound, MESSAGE.CargoConfig(file));
      }
      const parent = path.dirname(dir);
      dir = parent === dir ? null : parent;
    }
  }
}

/** The index of cargo's subcommand, or -1; refuses a rustup `+toolchain` before it. */
function subcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("+")) throw new Refused(RustEnvRefusal.RustupToolchain, MESSAGE.Rustup(arg));
    if (arg === "--") return -1;
    if (!arg.startsWith("-")) return i;
    if (VALUE_OPTIONS.has(arg)) i++;
  }
  return -1;
}

const isConfigOption = (arg: string) => arg === "--config" || arg.startsWith("--config=") || arg.startsWith("-Z");
const isManifestOption = (arg: string) => arg === "--manifest-path" || arg.startsWith("--manifest-path=");

/** Refuse what could pick another manifest, configuration or source; check every `--target`. */
function checkCargoOptions(layout: RustToolchainLayout, args: readonly string[], env: NodeJS.ProcessEnv): void {
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  own.forEach((arg, i) => {
    if (isManifestOption(arg)) {
      throw new Refused(RustEnvRefusal.ManifestOverride, MESSAGE.Manifest(path.join(layout.workspace, "Cargo.toml")));
    }
    if (isConfigOption(arg)) throw new Refused(RustEnvRefusal.ConfigOverride, MESSAGE.Config(arg));
    if (arg === "--target") checkTarget(layout, own[i + 1] ?? "", env);
    if (arg.startsWith("--target=")) checkTarget(layout, arg.slice("--target=".length), env);
  });
}

/**
 * The cargo argument list with `--manifest-path <workspace>/Cargo.toml` right after the
 * subcommand, after refusing what the helper never passes through.
 */
export function cargoArgv(
  layout: RustToolchainLayout,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): string[] {
  const at = subcommandIndex(args);
  checkCargoOptions(layout, args, env);
  checkCargoConfigs(layout, cwd);
  const sub = at < 0 ? "" : args[at];
  if (sub === "zigbuild") {
    checkTool(layout, path.join(layout.tools, "bin", "cargo-zigbuild"));
    checkTool(layout, path.join(layout.tools, "zig", "zig"));
  }
  if (!MANIFEST_SUBCOMMANDS.has(sub)) return [...args];
  const manifest = path.join(layout.workspace, "Cargo.toml");
  const after = manifestSlot(args, at);
  return [...args.slice(0, after), "--manifest-path", manifest, ...args.slice(after)];
}

/**
 * Where `--manifest-path` goes: right after the subcommand, or for a tool with commands of its
 * own (cargo-vet: `cargo vet init`, `cargo vet certify <crate> <version>`) right after that
 * command, which the tool refuses to recognize behind the option.
 */
function manifestSlot(args: readonly string[], at: number): number {
  const next = args[at + 1];
  const nestedCommand = NESTED_COMMAND_TOOLS.has(args[at]) && next !== undefined && !next.startsWith("-");
  return nestedCommand ? at + 2 : at + 1;
}

/** Another tool, which must be named bare and resolve inside the toolchain folder. */
function resolveTool(layout: RustToolchainLayout, tool: string, env: NodeJS.ProcessEnv): string {
  const found = tool.includes("/")
    ? undefined
    : (env.PATH ?? "")
        .split(path.delimiter)
        .map((dir) => path.join(dir, tool))
        .find((file) => isExecutable(file));
  if (found === undefined || !insideToolchain(layout, found)) {
    throw new Refused(RustEnvRefusal.ToolMissing, MESSAGE.ToolNotInstalled(tool, layout.dir));
  }
  return found;
}

/**
 * The environment cargo runs `args` with: `GENEX_NO_WINDOW=1` for a test or bench run unless the
 * caller set it to `0`, so no test can open a window; any other run keeps the caller's value.
 */
export function cargoEnvironment(env: NodeJS.ProcessEnv, args: readonly string[]): NodeJS.ProcessEnv {
  const at = subcommandIndex(args);
  const runsTests = at >= 0 && NO_WINDOW_SUBCOMMANDS.has(args[at]);
  if (!runsTests || env[NO_WINDOW_ENV] === NO_WINDOW_OPT_OUT) return env;
  return { ...env, [NO_WINDOW_ENV]: NO_WINDOW_ON };
}

/** POSIX shell lines that set the environment `rustEnvironment` gives. */
export function printedEnvironment(env: NodeJS.ProcessEnv): string {
  const exports = PRINTED_ENV.filter((name) => env[name]).map(
    (name) => `export ${name}=${shellQuote(env[name] ?? "")}`,
  );
  const wrappers = `export ${WRAPPER_VARIABLES.map((name) => `${name}=`).join(" ")}`;
  return [...exports, "unset RUSTUP_TOOLCHAIN RUSTUP_HOME", wrappers, ""].join("\n");
}

/** Run the tool with this process's stdio, pass signals on and exit as it did. */
function runTool(file: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  const child = spawn(file, args, { stdio: "inherit", env });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  child.on("error", (error) => {
    process.stderr.write(`rust-env: ${file}: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    for (const name of FORWARDED_SIGNALS) process.off(name, forward);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

function refusalLine(refused: Refused): string {
  const archives = refused.archives ? { archives: refused.archives } : {};
  return `${REFUSAL_PREFIX}${JSON.stringify({ code: refused.code, detail: refused.message, ...archives })}\n`;
}

function main(argv: readonly string[]): void {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length === 0) throw new Refused(RustEnvRefusal.Usage, MESSAGE.Usage);
  const layout = rustToolchainLayout();
  checkToolchain(layout);
  const env = rustEnvironment(layout);
  const [tool, ...rest] = args;
  if (tool === "--print-env") {
    process.stdout.write(printedEnvironment(env));
    return;
  }
  if (tool === "cargo") {
    const argv = cargoArgv(layout, rest, env, process.cwd());
    checkCleanQuiet(rest, env);
    const cargoEnv = colyseusEnvironment(layout, process.env, cargoEnvironment(env, rest), rest);
    runTool(path.join(layout.sysroot, "bin", "cargo"), argv, cargoEnv);
    return;
  }
  runTool(resolveTool(layout, tool, env), rest, env);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    process.stderr.write(refusalLine(error));
    process.exitCode = RUST_ENV_REFUSAL_EXIT;
  }
}
