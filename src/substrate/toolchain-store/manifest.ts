/**
 * The pinned components the toolchain store installs: one entry per tool and host, or per
 * destination artifact (host null). Data, with its pins; an entry with an unpinned
 * archive (`sha256: null`) is refused before any fetch, so a destination whose parts were never
 * downloaded and recorded fails typed (`unpinned`), never silently. A component Genex builds
 * itself is a pinned artifact: pinned by its folder's `manifest.json`, with no archive and no URL.
 * Every Genex build bundles the ANGLE builds `native/angle/bundle-lock.json` pins, so the store
 * installs those from the app's resources (`bundled.ts`), alongside the Linux headers pinned by
 * `native/linux-sysroot/bundle-lock.json`. A local artifact the app does not bundle and has not
 * published has no download (`not-hosted`).
 */
import { createHash } from "node:crypto";
import { BuildTarget, isBuildTarget } from "../../shared/game-project.ts";
import {
  ArchiveFormat,
  type ToolchainArchive,
  type ToolchainEntry,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  type ToolchainLocalArtifact,
  ToolchainProblem,
  ToolchainUnhosted,
} from "../../shared/toolchain.ts";
import { AngleTarget, BUNDLE_LOCK, commit12, isBundled } from "./bundled.ts";
import { LINUX_SYSROOT_BUNDLE_PIN } from "./linux-sysroot-bundle.ts";
import rustRecipeJson from "./rust-recipe.json" with { type: "json" };

const MESSAGE = {
  Unpinned: (id: string, url: string) => `${id} is not pinned yet: ${url} has no recorded sha256.`,
  NoPart: (id: string, into: string) => `${id} is not pinned yet: it has no archive for ${into}/.`,
  NotRelease: (id: string, url: string) =>
    `${id} names ${url}, which is not a durable release URL of its publisher: it is never installed.`,
  BadRecipe: (at: string) => `rust-recipe.json is not a pin table: ${at}.`,
} as const;

/** The public repository whose GitHub Releases carry what Genex builds and publishes itself. */
const GENEX_RELEASES = "https://github.com/genex-games/genex-desktop/releases/download/";

/**
 * Where each component may be downloaded from: its publisher's durable release locations, never a
 * CI artifact, a mirror or a branch. A manifest naming any other URL is refused when it loads
 * ({@link releaseManifest}). A component the app bundles (ANGLE) has no URL at all.
 */
export const RELEASE_URL_PREFIXES = {
  [ToolchainId.Cmake]: ["https://github.com/Kitware/CMake/releases/download/"],
  [ToolchainId.Ninja]: ["https://github.com/ninja-build/ninja/releases/download/"],
  [ToolchainId.Emsdk]: [
    "https://storage.googleapis.com/webassembly/emscripten-releases-builds/",
    "https://github.com/astral-sh/python-build-standalone/releases/download/",
  ],
  [ToolchainId.Zig]: ["https://ziglang.org/download/"],
  [ToolchainId.LlvmMingw]: ["https://github.com/mstorsjo/llvm-mingw/releases/download/"],
  [ToolchainId.RaylibSource]: ["https://github.com/raysan5/raylib/archive/refs/tags/"],
  [ToolchainId.AngleMac]: [],
  [ToolchainId.AngleWindows]: [],
  [ToolchainId.AngleLinux]: [],
  [ToolchainId.LinuxSysroot]: [GENEX_RELEASES],
  [ToolchainId.Rust]: ["https://static.rust-lang.org/dist/"],
  [ToolchainId.RustStdWasm]: ["https://static.rust-lang.org/dist/"],
  [ToolchainId.WasmBindgen]: ["https://github.com/wasm-bindgen/wasm-bindgen/releases/download/"],
  [ToolchainId.Binaryen]: ["https://github.com/WebAssembly/binaryen/releases/download/"],
  [ToolchainId.RustVendor]: [GENEX_RELEASES],
  [ToolchainId.RustStdWindows]: ["https://static.rust-lang.org/dist/"],
  [ToolchainId.RustStdLinux]: ["https://static.rust-lang.org/dist/"],
  [ToolchainId.CargoZigbuild]: ["https://github.com/rust-cross/cargo-zigbuild/releases/download/"],
  // Split out of the Linux ANGLE artifact and published by the owner beside the sysroot (M4.2, M4.7).
  [ToolchainId.SwiftShaderLinux]: [GENEX_RELEASES],
  // The person installs the Android SDK, Build-Tools and NDK with the SDK licence: the store finds
  // them and never downloads them (`USER_SIDE_COMPONENTS`).
  [ToolchainId.AndroidSdk]: [],
  [ToolchainId.AndroidBuildTools]: [],
  [ToolchainId.AndroidNdk]: [],
  [ToolchainId.Bundletool]: ["https://github.com/google/bundletool/releases/download/"],
  // Temurin 21 (`JDK_PIN`): Adoptium's GitHub releases for that feature version.
  [ToolchainId.Jdk]: ["https://github.com/adoptium/temurin21-binaries/releases/download/"],
  [ToolchainId.RustStdIos]: ["https://static.rust-lang.org/dist/"],
  [ToolchainId.RustStdIosSim]: ["https://static.rust-lang.org/dist/"],
  [ToolchainId.RustStdAndroid]: ["https://static.rust-lang.org/dist/"],
  [ToolchainId.CargoDeny]: ["https://github.com/EmbarkStudios/cargo-deny/releases/download/"],
  [ToolchainId.CargoVet]: ["https://github.com/mozilla/cargo-vet/releases/download/"],
  // One commit's tree of the RustSec database, as GitHub archives it: `crate-policy.json` pins it.
  [ToolchainId.RustsecAdvisoryDb]: ["https://github.com/rustsec/advisory-db/archive/"],
} as const satisfies Record<ToolchainId, readonly string[]>;

/**
 * Whether `url` is a durable release URL of `id`'s publisher: https, no credentials, the prefix's
 * own host and a path under its prefix once the URL is normalized (so `..` cannot climb out).
 */
export function isReleaseUrl(id: ToolchainId, url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return false;
  return RELEASE_URL_PREFIXES[id].some((prefix) => {
    const allowed = new URL(prefix);
    return parsed.origin === allowed.origin && parsed.pathname.startsWith(allowed.pathname);
  });
}

/** Every URL `entry` may download: its archives' and a pinned artifact's published archive. */
function entryUrls(entry: ToolchainEntry): string[] {
  const fetched = entry.local?.fetch?.url;
  return [...entry.archives.map((archive) => archive.url), ...(fetched ? [fetched] : [])];
}

/** `entries`, after refusing (typed `unpinned`) the first that names a URL off its publisher's release host. */
export function releaseManifest<T extends readonly ToolchainEntry[]>(entries: T): T {
  for (const entry of entries) {
    const stray = entryUrls(entry).find((url) => !isReleaseUrl(entry.id, url));
    if (stray !== undefined) throw new ToolchainError(ToolchainProblem.Unpinned, MESSAGE.NotRelease(entry.id, stray));
  }
  return entries;
}

const KITWARE = "https://github.com/Kitware/CMake/releases/download/v4.4.3";
const NINJA = "https://github.com/ninja-build/ninja/releases/download/v1.13.2";
const ZIG = "https://ziglang.org/download/0.16.0";
const LLVM_MINGW = "https://github.com/mstorsjo/llvm-mingw/releases/download/20260922";
/** Emscripten 6.0.10's release build (`emscripten-releases` revision). */
const EMSCRIPTEN_BUILDS = "https://storage.googleapis.com/webassembly/emscripten-releases-builds";
const EMSCRIPTEN_REVISION = "666337b525e673e769121856d175f6f52b8ead64";
/** emsdk's Linux host uses system Python upstream; Genex installs this portable, managed build. */
const PYTHON_LINUX = "https://github.com/astral-sh/python-build-standalone/releases/download/20250529";
/** The ANGLE commit every Genex ANGLE build is made from. */
const ANGLE_COMMIT = commit12(BUNDLE_LOCK);
/** The image the Linux sysroot's headers come from (AlmaLinux 8.10, glibc 2.28: the Linux floor). */
const LINUX_SYSROOT_VERSION = LINUX_SYSROOT_BUNDLE_PIN.version;
/** raylib 6.0's source, as the tag's archive (the same tree as git tag 6.0, commit dbc56a87). */
const RAYLIB_SOURCE = "https://github.com/raysan5/raylib/archive/refs/tags/6.0.tar.gz";

const LICENCE = {
  Cmake: "BSD-3-Clause",
  Ninja: "Apache-2.0",
  Emsdk: "MIT OR NCSA (Emscripten); Apache-2.0 WITH LLVM-exception (LLVM, Binaryen); MIT (Node.js); PSF-2.0 (Python)",
  Zig: "MIT",
  LlvmMingw: "Apache-2.0 WITH LLVM-exception; ZPL-2.1 (mingw-w64)",
  Raylib: "Zlib",
  Angle: "BSD-3-Clause",
  LinuxSysroot: "MIT (X11, Wayland, xkbcommon headers and link-time libraries; GLFW Wayland protocol code)",
} as const;

/** An archive nobody has downloaded and recorded yet: installing it is refused `unpinned`. */
function unpinned(url: string, format: ArchiveFormat, strip: number, into = ""): ToolchainArchive {
  return { url, bytes: 0, sha256: null, format, strip, into };
}

function entry(
  id: ToolchainId,
  version: string,
  host: ToolchainHost | null,
  target: BuildTarget | null,
  licence: string,
  archives: ToolchainArchive[],
): ToolchainEntry {
  return Object.freeze({ id, version, host, target, archives: Object.freeze(archives) as ToolchainArchive[], licence });
}

/** A destination artifact Genex built and pinned by its manifest: no archive, no URL. */
function localArtifact(
  id: ToolchainId,
  target: BuildTarget,
  licence: string,
  local: ToolchainLocalArtifact,
  version: string = ANGLE_COMMIT,
): ToolchainEntry {
  const none: ToolchainArchive[] = [];
  return Object.freeze({
    id,
    version,
    host: null,
    target,
    archives: Object.freeze(none) as ToolchainArchive[],
    licence,
    local: Object.freeze(local),
  });
}

// Mac archives were recorded from one download (2026-10-01), second source pending.
// Linux CMake/Ninja/Python (2026-10-02) match their publishers' release digests/checksum assets;
// Emsdk's Linux Node mirror matches nodejs.org/dist/v24.19.0/SHASUMS256.txt and downloaded bytes.
const PINNED = {
  cmakeMac: {
    url: `${KITWARE}/cmake-4.4.3-macos-universal.tar.gz`,
    bytes: 89_445_170,
    sha256: "0c5d65251c14cc884bfa16bdbed3c263ce5bffe2e21c0d0d00962cb0610464fa",
    format: ArchiveFormat.TarGz,
    strip: 1,
    into: "",
  },
  cmakeLinux: {
    url: `${KITWARE}/cmake-4.4.3-linux-x86_64.tar.gz`,
    bytes: 64_872_980,
    sha256: "d6c83076c575bc00b823522ac974bda66d0af05d6ddc30e739c12385cf32c6cc",
    format: ArchiveFormat.TarGz,
    strip: 1,
    into: "",
  },
  ninjaMac: {
    url: `${NINJA}/ninja-mac.zip`,
    bytes: 314_051,
    sha256: "c99048673aa765960a99cf10c6ddb9f1fad506099ff0a0e137ad8960a88f321b",
    format: ArchiveFormat.Zip,
    strip: 0,
    into: "",
  },
  ninjaLinux: {
    url: `${NINJA}/ninja-linux.zip`,
    bytes: 134_040,
    sha256: "5749cbc4e668273514150a80e387a957f933c6ed3f5f11e03fb30955e2bbead6",
    format: ArchiveFormat.Zip,
    strip: 0,
    into: "",
  },
  zigMac: {
    url: `${ZIG}/zig-aarch64-macos-0.16.0.tar.xz`,
    bytes: 52_238_004,
    sha256: "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489",
    format: ArchiveFormat.TarXz,
    strip: 1,
    into: "",
  },
  zigLinux: {
    url: `${ZIG}/zig-x86_64-linux-0.16.0.tar.xz`,
    bytes: 55_478_392,
    sha256: "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
    format: ArchiveFormat.TarXz,
    strip: 1,
    into: "",
  },
  llvmMingwMac: {
    url: `${LLVM_MINGW}/llvm-mingw-20260922-ucrt-macos-universal.tar.xz`,
    bytes: 124_289_672,
    sha256: "52e5f5a7b131021d0c39a37a38fa380a1da7885cd04bd61afd0cd4ecfb8bc1f3",
    format: ArchiveFormat.TarXz,
    strip: 1,
    into: "",
  },
  emscriptenMac: {
    url: `${EMSCRIPTEN_BUILDS}/mac/${EMSCRIPTEN_REVISION}/wasm-binaries-arm64.tar.xz`,
    bytes: 276_811_332,
    sha256: "084896c728d82e44d7aa54afc4a7bf64031dda83f3a4c47ee3164cece247cd76",
    format: ArchiveFormat.TarXz,
    strip: 1,
    into: "install",
  },
  emsdkNodeMac: {
    url: `${EMSCRIPTEN_BUILDS}/deps/node-v24.19.0-darwin-arm64.tar.gz`,
    bytes: 52_234_372,
    sha256: "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d",
    format: ArchiveFormat.TarGz,
    strip: 1,
    into: "node",
  },
  emsdkPythonMac: {
    url: `${EMSCRIPTEN_BUILDS}/deps/python-3.13.3-0-macos-arm64.tar.gz`,
    bytes: 44_280_478,
    sha256: "2b0899d7ade9463b0c909ef23aeea27546a4f412637998d817a49718bc2bac19",
    format: ArchiveFormat.TarGz,
    strip: 0,
    into: "python",
  },
  emscriptenLinux: {
    url: `${EMSCRIPTEN_BUILDS}/linux/${EMSCRIPTEN_REVISION}/wasm-binaries.tar.xz`,
    bytes: 299_612_332,
    sha256: "a51dd2829bdf725d268974728e032533b106ea01cb482a62288ec12627a7abbe",
    format: ArchiveFormat.TarXz,
    strip: 1,
    into: "install",
  },
  emsdkNodeLinux: {
    url: `${EMSCRIPTEN_BUILDS}/deps/node-v24.19.0-linux-x64.tar.xz`,
    bytes: 31_633_904,
    sha256: "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647",
    format: ArchiveFormat.TarXz,
    strip: 1,
    into: "node",
  },
  emsdkPythonLinux: {
    url: `${PYTHON_LINUX}/cpython-3.13.3%2B20250529-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
    bytes: 35_346_222,
    sha256: "532a6db30bcf8f8609a0c4e0a7c985315572364c19868bc9650a64df534954e7",
    format: ArchiveFormat.TarGz,
    strip: 1,
    into: "python",
  },
  raylibSource: {
    url: RAYLIB_SOURCE,
    bytes: 52_545_040,
    sha256: "2b3ee1e2120c7a0796b33062c7e9a694dd8a8caa56a96319ac8c8ecf54a90d0b",
    format: ArchiveFormat.TarGz,
    strip: 1,
    into: "",
  },
} as const satisfies Record<string, ToolchainArchive>;

// Built by angle.yml from the one ANGLE commit and pinned file by file by each build's
// manifest.json (native/angle/bundle-lock.json, which also names the run). No download exists:
// every Genex build bundles them, and the store installs them from the app's resources.
const ANGLE = {
  mac: { ...BUNDLE_LOCK.targets[AngleTarget.MacArm64Metal], reason: ToolchainUnhosted.NotPublished },
  windows: { ...BUNDLE_LOCK.targets[AngleTarget.WindowsX64D3d11], reason: ToolchainUnhosted.NotPublished },
  linux: { ...BUNDLE_LOCK.targets[AngleTarget.LinuxX64Vulkan], reason: ToolchainUnhosted.NotPublished },
} as const satisfies Record<string, ToolchainLocalArtifact>;

// Built by scripts/toolchains/linux-sysroot.ts from the almalinux:8 headers (pinned by image digest)
// and GLFW's Wayland protocol code generated there; verified file by file against its manifest.json.
const LINUX_SYSROOT: ToolchainLocalArtifact = {
  manifestSha256: LINUX_SYSROOT_BUNDLE_PIN.manifestSha256,
  fetch: {
    url: null,
    sha256: LINUX_SYSROOT_BUNDLE_PIN.archive.sha256,
    bytes: LINUX_SYSROOT_BUNDLE_PIN.archive.bytes,
    format: ArchiveFormat.TarGz,
  },
  manifestBytes: LINUX_SYSROOT_BUNDLE_PIN.manifestBytes,
  files: LINUX_SYSROOT_BUNDLE_PIN.files,
  bytes: LINUX_SYSROOT_BUNDLE_PIN.bytes,
  reason: ToolchainUnhosted.NotPublished,
};

/** Every entry the C++ · raylib store installs (the Rust stack's are {@link RUST_MANIFEST}). */
export const TOOLCHAIN_MANIFEST: readonly ToolchainEntry[] = releaseManifest(
  Object.freeze([
    entry(ToolchainId.Cmake, "4.4.3", ToolchainHost.MacArm64, null, LICENCE.Cmake, [PINNED.cmakeMac]),
    entry(ToolchainId.Cmake, "4.4.3", ToolchainHost.LinuxX64, null, LICENCE.Cmake, [PINNED.cmakeLinux]),
    entry(ToolchainId.Cmake, "4.4.3", ToolchainHost.WindowsX64, null, LICENCE.Cmake, [
      unpinned(`${KITWARE}/cmake-4.4.3-windows-x86_64.zip`, ArchiveFormat.Zip, 1),
    ]),
    entry(ToolchainId.Ninja, "1.13.2", ToolchainHost.MacArm64, null, LICENCE.Ninja, [PINNED.ninjaMac]),
    entry(ToolchainId.Ninja, "1.13.2", ToolchainHost.LinuxX64, null, LICENCE.Ninja, [PINNED.ninjaLinux]),
    entry(ToolchainId.Ninja, "1.13.2", ToolchainHost.WindowsX64, null, LICENCE.Ninja, [
      unpinned(`${NINJA}/ninja-win.zip`, ArchiveFormat.Zip, 0),
    ]),
    entry(ToolchainId.Emsdk, "6.0.10", ToolchainHost.MacArm64, null, LICENCE.Emsdk, [
      PINNED.emscriptenMac,
      PINNED.emsdkNodeMac,
      PINNED.emsdkPythonMac,
    ]),
    // Keep all three parts in the store on Linux, including a portable Python instead of the
    // upstream emsdk system-python fallback. Installation probes both managed runtimes.
    entry(ToolchainId.Emsdk, "6.0.10", ToolchainHost.LinuxX64, null, LICENCE.Emsdk, [
      PINNED.emscriptenLinux,
      PINNED.emsdkNodeLinux,
      PINNED.emsdkPythonLinux,
    ]),
    entry(ToolchainId.Emsdk, "6.0.10", ToolchainHost.WindowsX64, null, LICENCE.Emsdk, [
      unpinned(`${EMSCRIPTEN_BUILDS}/win/${EMSCRIPTEN_REVISION}/wasm-binaries.zip`, ArchiveFormat.Zip, 1, "install"),
      unpinned(`${EMSCRIPTEN_BUILDS}/deps/node-v24.19.0-win-x64.zip`, ArchiveFormat.Zip, 1, "node"),
      unpinned(`${EMSCRIPTEN_BUILDS}/deps/python-3.13.3-0-win-amd64.zip`, ArchiveFormat.Zip, 0, "python"),
    ]),
    entry(ToolchainId.Zig, "0.16.0", ToolchainHost.MacArm64, null, LICENCE.Zig, [PINNED.zigMac]),
    entry(ToolchainId.Zig, "0.16.0", ToolchainHost.LinuxX64, null, LICENCE.Zig, [PINNED.zigLinux]),
    entry(ToolchainId.Zig, "0.16.0", ToolchainHost.WindowsX64, null, LICENCE.Zig, [
      unpinned(`${ZIG}/zig-x86_64-windows-0.16.0.zip`, ArchiveFormat.Zip, 1),
    ]),
    entry(ToolchainId.LlvmMingw, "20260922", ToolchainHost.MacArm64, null, LICENCE.LlvmMingw, [PINNED.llvmMingwMac]),
    entry(ToolchainId.RaylibSource, "6.0", null, null, LICENCE.Raylib, [PINNED.raylibSource]),
    localArtifact(ToolchainId.AngleMac, BuildTarget.Mac, LICENCE.Angle, ANGLE.mac),
    localArtifact(ToolchainId.AngleWindows, BuildTarget.Windows, LICENCE.Angle, ANGLE.windows),
    localArtifact(ToolchainId.AngleLinux, BuildTarget.Linux, LICENCE.Angle, ANGLE.linux),
    localArtifact(
      ToolchainId.LinuxSysroot,
      BuildTarget.Linux,
      LICENCE.LinuxSysroot,
      LINUX_SYSROOT,
      LINUX_SYSROOT_VERSION,
    ),
  ]),
);

// ---------- the Rust stack's pins (rust-recipe.json) ----------

const TOOLCHAIN_IDS: ReadonlySet<string> = new Set<string>(Object.values(ToolchainId));
const TOOLCHAIN_HOSTS: ReadonlySet<unknown> = new Set<unknown>([null, ...Object.values(ToolchainHost)]);
const ARCHIVE_FORMATS: ReadonlySet<unknown> = new Set<unknown>(Object.values(ArchiveFormat));
const SHA256 = /^[0-9a-f]{64}$/;

/** A JSON object, for the recipe's shape checks. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One recipe archive, shape-checked: a positive size, a recorded sha256, a known format. */
function recipeArchive(value: unknown, at: string): ToolchainArchive {
  const shaped =
    isObject(value) &&
    typeof value.url === "string" &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) > 0 &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    ARCHIVE_FORMATS.has(value.format) &&
    Number.isSafeInteger(value.strip) &&
    typeof value.into === "string";
  if (!shaped) throw new Error(MESSAGE.BadRecipe(at));
  return Object.freeze({
    url: value.url as string,
    bytes: value.bytes as number,
    sha256: value.sha256 as string,
    format: value.format as ArchiveFormat,
    strip: value.strip as number,
    into: value.into as string,
  });
}

/** One recipe entry, shape-checked. */
function recipeEntry(value: unknown, index: number): ToolchainEntry {
  const at = `entries[${index}]`;
  if (!isObject(value) || typeof value.id !== "string" || !TOOLCHAIN_IDS.has(value.id))
    throw new Error(MESSAGE.BadRecipe(at));
  const target = value.target === null || isBuildTarget(value.target) ? value.target : undefined;
  const typed = typeof value.version === "string" && TOOLCHAIN_HOSTS.has(value.host) && target !== undefined;
  if (!typed || typeof value.licence !== "string" || !Array.isArray(value.archives))
    throw new Error(MESSAGE.BadRecipe(at));
  const archives = value.archives.map((archive, part) => recipeArchive(archive, `${at}.archives[${part}]`));
  return entry(
    value.id as ToolchainId,
    value.version as string,
    value.host as ToolchainHost | null,
    target,
    value.licence,
    archives,
  );
}

/** The entries of a Rust recipe (`rust-recipe.json`'s shape), checked whole and held to their release hosts. */
export function rustManifestOf(recipe: unknown): readonly ToolchainEntry[] {
  if (!isObject(recipe) || recipe.schema !== 1 || !Array.isArray(recipe.entries))
    throw new Error(MESSAGE.BadRecipe("schema 1 with entries"));
  return releaseManifest(Object.freeze(recipe.entries.map(recipeEntry)));
}

/**
 * Every entry the Rust · wgpu store installs: the pinned Rust sysroot per host, the browser's
 * standard library, wasm-bindgen and binaryen (`rust-recipe.json`). Kept apart from
 * {@link TOOLCHAIN_MANIFEST}, so the C++ setup never lists a Rust download.
 */
export const RUST_MANIFEST: readonly ToolchainEntry[] = rustManifestOf(rustRecipeJson);

/** The folders the `rust` component's archives unpack into, one per dist tarball (`locate.ts` `RUST_COMPONENT_LAYOUT`). */
export const RUST_PARTS = ["rustc", "cargo", "clippy", "llvm-tools", "rust-std"] as const;

/**
 * The subfolders (`into`) a component's archives must fill before it counts as pinned: emsdk runs
 * its own Node and Python, never the system's (`COMPONENT_LAYOUT` in `locate.ts`).
 */
const ENTRY_PARTS: Readonly<Partial<Record<ToolchainId, readonly string[]>>> = {
  [ToolchainId.Emsdk]: ["install", "node", "python"],
  [ToolchainId.Rust]: RUST_PARTS,
};

/** The first part `entry` has no archive for, or null. */
function missingPart(entry: ToolchainEntry): string | null {
  const parts = ENTRY_PARTS[entry.id] ?? [];
  return parts.find((into) => !entry.archives.some((archive) => archive.into === into)) ?? null;
}

/** The entry for `id` on `host` (a destination artifact serves every host), or null when the manifest has none. */
export function manifestEntry(id: ToolchainId, host: ToolchainHost): ToolchainEntry | null {
  const entries = [...TOOLCHAIN_MANIFEST, ...RUST_MANIFEST];
  const own = entries.find((item) => item.id === id && item.host === host);
  return own ?? entries.find((item) => item.id === id && item.host === null) ?? null;
}

/**
 * Whether `entry`'s digest is recorded: every archive has a sha256 and it has an archive for every
 * part it needs, or it is a pinned artifact (its folder's `manifest.json` digest; no archives).
 */
export function isPinned(entry: ToolchainEntry): boolean {
  if (entry.local) return entry.archives.length === 0;
  const recorded = entry.archives.every((archive) => archive.sha256 !== null);
  return entry.archives.length > 0 && recorded && missingPart(entry) === null;
}

/**
 * Whether the store can install `entry` by itself, from a pinned download or from the app's own
 * resources (an artifact every Genex build bundles: ANGLE, never fetched). A pinned local artifact
 * may instead have a separately pinned archive with a published URL.
 */
export function isDownloadable(entry: ToolchainEntry): boolean {
  if (!isPinned(entry)) return false;
  if (entry.local === undefined || isBundled(entry)) return true;
  const fetch = entry.local.fetch;
  return fetch?.url !== null && fetch?.url !== undefined && /^[0-9a-f]{64}$/.test(fetch.sha256) && fetch.bytes > 0;
}

/**
 * The entry's digest: a pinned artifact's `manifest.json` sha256; else its one archive's sha256,
 * or sha256 over its archives' `sha256` values joined by `\n`. A receipt records it; its first 12
 * hex name the install folder. Refused `unpinned` for an entry with an unrecorded archive or
 * without an archive for a part it needs.
 */
export function entryDigest(entry: ToolchainEntry): string {
  if (entry.local && entry.archives.length === 0) return entry.local.manifestSha256;
  const digests = entry.archives.map((archive) => archive.sha256);
  const missing = entry.archives.find((archive) => archive.sha256 === null);
  if (missing || digests.length === 0)
    throw new ToolchainError(ToolchainProblem.Unpinned, MESSAGE.Unpinned(entry.id, missing?.url ?? entry.id));
  const part = missingPart(entry);
  if (part !== null) throw new ToolchainError(ToolchainProblem.Unpinned, MESSAGE.NoPart(entry.id, part));
  if (digests.length === 1) return digests[0] ?? "";
  return createHash("sha256").update(digests.join("\n")).digest("hex");
}

/**
 * The entry's short digest: the first 12 hex of {@link entryDigest} (a pinned artifact's manifest
 * digest, one archive's own digest, or sha256 over several archives' digests joined by `\n`).
 * The install folder is `<version>-<sha12>`.
 */
export function entrySha12(entry: ToolchainEntry): string {
  return entryDigest(entry).slice(0, 12);
}
