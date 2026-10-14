/**
 * Admission of a Mac build of a C++ · raylib game, and the run directory it starts from. A build's
 * `out/` is agent-made: the host reads its Mach-O load commands itself (thin arm64 only; a fat or
 * truncated file is refused), refuses links, hard links, an extra executable, an OpenGL import
 * (link-time imports only: on macOS 26 loading Metal maps OpenGL at run time, so a runtime check
 * would refuse every game), a missing ANGLE import and any rpath but `MAC_GAME_RPATH`, and then
 * assembles `Game.app` in a host-only run directory: the admitted executable copied without
 * following links, a host-written `Info.plist`, the store's ANGLE (checked against the lock's
 * digest) and the staged assets, signed ad hoc inside out.
 *
 * Assembly reads every byte it writes once and checks those bytes, not the file they came from:
 * an executable or asset swapped after admission is refused, and the run directory removed. A Mac
 * app export (`native-export.ts`) assembles its `.app` from the same checked reads and copies.
 *
 * A Rust · wgpu game draws through Metal and links no ANGLE: its admission (`admitWgpuBundle`)
 * keeps every other rule and holds the executable to the Rust Mac policy instead (`admitRustMachO`,
 * M3.5): `LC_BUILD_VERSION` names macOS, every import is an allow-listed system framework or
 * `/usr/lib` library, and it carries no OpenGL, rpath or loader setting. Its run directory
 * (`assembleWgpuRunDir`) is the same `Game.app` without `Frameworks/`, the app alone signed ad hoc,
 * assembled only from the bytes the Rust lane admitted: the executable and every asset must match
 * the lane's recorded digests, and the assets must be exactly the admitted set, so a write that
 * reached `out/` after admission (a late writer) never reaches the run.
 * An iOS build (device or Simulator) is held to the same policy with the iOS allow-list, platform
 * IOS or IOSSIMULATOR and minos {@link IOS_MINIMUM_OS_VERSION}.
 */
import { createHash } from "node:crypto";
import { type Dirent, constants as FS, type Stats } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import { BuildTarget } from "../shared/game-project.ts";
import {
  IOS_MINIMUM_OS_VERSION,
  MAC_ANGLE_IMPORTS,
  MAC_GAME_RPATH,
  MAC_MINIMUM_SYSTEM_VERSION,
  NATIVE_BUNDLE_APP,
  NATIVE_MAC_EXECUTABLES,
  NativeError,
  NativeRefusal,
  NativeRunMode,
  RustAdmissionProblem,
  type RustBinaryRefusal,
} from "../shared/native-contract.ts";
import { isJsonObject, openNoFollow } from "./fsx.ts";

const MESSAGE = {
  Short: "the file ends before its Mach-O header does",
  Fat: "a universal (fat) file: only a thin arm64 Mach-O is admitted",
  Magic: "not a 64-bit Mach-O file",
  NotArm64: "not an arm64 Mach-O file",
  FileType: "neither an executable nor a library",
  Commands: "its load commands run past the file or do not add up",
  BadString: "a load command's string is out of bounds, unterminated or not UTF-8",
  TooLarge: (file: string, max: number) => `${file} is larger than ${max} bytes`,
  NotRegular: (file: string) => `${file} is not a regular file`,
  Link: (file: string) => `${file} is a link`,
  Changed: (file: string) => `${file} changed after it was listed: a file or a folder on its way was swapped`,
  HardLink: (file: string) => `${file} has another hard link`,
  Unreadable: (file: string, detail: string) => `${file} cannot be read: ${detail}`,
  NoExecutable: (mode: string) => `a ${mode} run has no Mac executable`,
  NotExecutable: (file: string) => `${file} is a library, not an executable`,
  OpenGl: (name: string) => `it links Apple's OpenGL (${name}); a game draws through the bundled ANGLE`,
  MissingAngle: (name: string) => `it does not import ${name}, the bundled ANGLE`,
  ForeignRpath: (rpaths: readonly string[]) =>
    `its library search path is ${JSON.stringify(rpaths)}; only ${MAC_GAME_RPATH} is allowed`,
  DyldEnvironment: "it sets the dynamic loader's environment for itself",
  ExtraMachO: (file: string) => `${file} is a Mach-O file among the assets`,
  AngleManifest: "the store's ANGLE manifest is not the one the lock pins",
  AngleLibrary: (name: string) => `the store's ${name} is not the pinned build`,
  BadRunId: "a run id is 12 to 32 lowercase hexadecimal characters",
  BadBundleId: "a game's bundle id is games.genex.game. and 12 lowercase hexadecimal characters",
  RunDirTaken: (dir: string) => `the run directory ${dir} exists already`,
  NotARunDir: (dir: string) => `${dir} is not a run directory`,
  Unsigned: (file: string, detail: string) => `codesign could not sign ${file}: ${detail}`,
  BuildVersionShort: "LC_BUILD_VERSION is shorter than its fields",
  RustGl: (name: string) => `it imports ${name}; a Rust game draws through wgpu on Metal alone`,
  RustForeign: (name: string, target: string) =>
    `it imports ${name}, which is not a system library a Rust game on ${target} may link`,
  RustRpath: (rpaths: readonly string[]) =>
    `its library search path is ${JSON.stringify(rpaths)}; a Rust game carries none`,
  NoBuildVersion: (target: string) => `it names no single LC_BUILD_VERSION, so nothing says it is a ${target} program`,
  WrongPlatform: (platform: number, target: string) => `LC_BUILD_VERSION names platform ${platform}, not ${target}`,
  Minos: (minos: string) => `its minimum OS is ${minos}; an iOS game is built for ${IOS_MINIMUM_OS_VERSION}`,
  NotAdmitted: (file: string) => `${file} is not the file the build lane admitted: it changed after admission`,
  AdmittedSet: (files: readonly string[]) =>
    `the build's assets are not the ones the lane admitted (${files.join(", ")} added or removed after admission)`,
} as const;

/** The Mach-O file types admission reads. Wire values of nothing: names for `MH_EXECUTE` and `MH_DYLIB`. */
export const MachOFileType = { Execute: "execute", Dylib: "dylib" } as const;
export type MachOFileType = (typeof MachOFileType)[keyof typeof MachOFileType];

/** `LC_BUILD_VERSION` platforms, as `<mach-o/loader.h>` numbers them (Apple's numbers, not a Genex vocabulary). */
export const ApplePlatformCode = { MacOs: 1, Ios: 2, IosSimulator: 7 } as const;
export type ApplePlatformCode = (typeof ApplePlatformCode)[keyof typeof ApplePlatformCode];

/** One `LC_BUILD_VERSION`: the platform number and the minimum OS release, `major.minor[.patch]`. */
export interface MachOBuildVersion {
  platform: number;
  minos: string;
}

/** The Apple destinations a Rust · wgpu game is built for. */
export type AppleRustTarget = typeof BuildTarget.Mac | typeof BuildTarget.Ios;

/** A Rust Apple binary the policy admitted: its load commands and its one build version. */
export type RustMachOAdmission = { ok: true; image: MachOImage; version: MachOBuildVersion } | RustBinaryRefusal;

/** What a thin arm64 Mach-O's load commands say. */
export interface MachOImage {
  fileType: MachOFileType;
  /** Every imported library (`LC_LOAD_DYLIB`, weak, re-exported, lazy, upward) by install name, in file order. */
  dylibs: string[];
  /** `LC_RPATH` paths, in file order. */
  rpaths: string[];
  /** `LC_ID_DYLIB`, for a library; null for an executable. */
  id: string | null;
  /** `LC_DYLD_ENVIRONMENT` settings (`DYLD_LIBRARY_PATH=…`): the loader's search paths, set by the file itself. */
  environment: string[];
}

/** One executable admitted from a Mac build's `out/`, with the staged assets beside it. */
export interface AdmittedMacBundle {
  mode: NativeRunMode;
  /** The executable in the lane's output, as admitted (copied, never linked, into the bundle). */
  exe: string;
  image: MachOImage;
  /** The lane's staged `assets/`, or null when the game has none. */
  assets: string | null;
}

/** Admission's answer: the admitted bundle, or the typed refusal and what it was about. */
export type MacAdmission =
  | { ok: true; bundle: AdmittedMacBundle }
  | { ok: false; refusal: NativeRefusal; detail: string };

/** The store's Mac ANGLE, as `LocatedToolchain.angle` names it. */
export interface MacAngle {
  dir: string;
  egl: string;
  gles: string;
  /** sha256 of the folder's `manifest.json`: the lock's pin. */
  manifestSha256: string;
}

/** A host program run without a shell (`codesign`), never throwing: a failure is its exit code. */
export type BundleExec = (
  file: string,
  args: readonly string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** What one run directory is assembled from. */
export interface RunDirRequest {
  /** `layout.nativeRuns`: the run directory is `<root>/<runId>`, host-only. */
  root: string;
  runId: string;
  admitted: AdmittedMacBundle;
  angle: MacAngle;
  /** The game's once-chosen bundle identifier (`GameLibraryEntry.native.bundleId`), never the build's. */
  bundleId: string;
  /** No Dock icon (`LSUIElement`); a headless run never gets one either way. */
  uiElement: boolean;
  /** `CFBundleName`: the game's title (escaped, cut to {@link BUNDLE_NAME_MAX_CHARS}); "Game" when absent. */
  gameName?: string;
  exec: BundleExec;
  /**
   * Runs between the asset listing and the copies (default: nothing): a test stands in a process
   * the build left running, still writing `out/` while the host assembles.
   */
  afterListing?: () => Promise<void>;
}

/** An assembled run directory: `bundle/` (read-only to the game) and `state/` (its only writable folder). */
export interface AssembledRunDir {
  runDir: string;
  /** `<runDir>/bundle/Game.app/Contents/MacOS/game`, realpath'd. */
  exe: string;
  bundle: string;
  state: string;
}

/** The most bytes of a game executable the host reads; a bigger one is not admitted. */
const EXECUTABLE_MAX_BYTES = 256 * 1024 ** 2;
/** The most bytes of one store ANGLE library, and of its manifest. */
const ANGLE_LIBRARY_MAX_BYTES = 64 * 1024 ** 2;
const ANGLE_MANIFEST_MAX_BYTES = 1024 ** 2;
/** The most bytes of load commands a header may declare. */
const LOAD_COMMANDS_MAX_BYTES = 1024 ** 2;
/** Chunk size of an asset copy. */
const COPY_CHUNK_BYTES = 1024 ** 2;
/** `CFBundleName` is cut to this many characters. */
const BUNDLE_NAME_MAX_CHARS = 64;
/** What a run id and a game's bundle id may be. */
const RUN_ID = /^[0-9a-f]{12,32}$/;
const BUNDLE_ID = /^games\.genex\.game\.[0-9a-f]{12}$/;
/** The bundle id's prefix and how many hex digits of the game folder's real-path digest follow it. */
const BUNDLE_ID_PREFIX = "games.genex.game.";
const BUNDLE_ID_DIGITS = 12;

/**
 * A run directory's layout, `<layout.nativeRuns>/<runId>/{bundle,state}`: assembly writes it and
 * `spawnGame` checks a start request against it, both from this one table.
 */
export const RunDirLayout = {
  /** `<runDir>/bundle`: `Game.app`, read-only to the game. */
  Bundle: "bundle",
  /** `<runDir>/state`: the game's only writable folder. */
  State: "state",
  /** `state/home`: the game's HOME. */
  Home: "home",
  /** `state/captures`: where a run's captures land. */
  Captures: "captures",
  /** `Game.app/Contents/MacOS/game`: the one program a run starts. */
  Executable: "game",
  /** `<runDir>/launch.claim`: created exclusively by a Windows or Linux start, so a second start of the run finds it. */
  Claim: "launch.claim",
} as const;
export type RunDirLayout = (typeof RunDirLayout)[keyof typeof RunDirLayout];

/** Whether `value` names a run directory: 12 to 32 lowercase hexadecimal characters. */
export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/** Whether `value` is a bundle id the studio chooses: `games.genex.game.` and 12 lowercase hex digits. */
export function isBundleId(value: string): boolean {
  return BUNDLE_ID.test(value);
}

/** The bundle id the studio chooses for the game folder whose real path is `realDir`. */
export function bundleIdOf(realDir: string): string {
  return `${BUNDLE_ID_PREFIX}${createHash("sha256").update(realDir).digest("hex").slice(0, BUNDLE_ID_DIGITS)}`;
}

/** The one program a run starts: `<bundle>/Game.app/Contents/MacOS/game`. */
export function bundleExecutable(bundle: string): string {
  return path.join(bundle, NATIVE_BUNDLE_APP, "Contents", "MacOS", RunDirLayout.Executable);
}

/** Mach-O header fields and load commands, as `<mach-o/loader.h>` numbers them. */
const MachO = {
  HeaderBytes: 32,
  Magic64: 0xfeedfacf,
  CpuArm64: 0x0100000c,
  Execute: 2,
  Dylib: 6,
  /** The smallest a load command can be: its `cmd` and `cmdsize`. */
  MinCommandBytes: 8,
  /** 64-bit load commands are sized in multiples of 8. */
  CommandAlign: 8,
  /** Where `dylib_command`'s and the path commands' strings may start. */
  DylibCommandBytes: 24,
  PathCommandBytes: 12,
  LoadDylib: 0xc,
  IdDylib: 0xd,
  LoadWeakDylib: 0x80000018,
  Rpath: 0x8000001c,
  ReexportDylib: 0x8000001f,
  LazyLoadDylib: 0x20,
  LoadUpwardDylib: 0x80000023,
  DyldEnvironment: 0x27,
  BuildVersion: 0x32,
  /** `build_version_command` up to its tool count: cmd, cmdsize, platform, minos, sdk, ntools. */
  BuildVersionBytes: 24,
} as const;

/** Every load command that makes the loader bind a library. */
const IMPORT_COMMANDS: ReadonlySet<number> = new Set([
  MachO.LoadDylib,
  MachO.LoadWeakDylib,
  MachO.ReexportDylib,
  MachO.LazyLoadDylib,
  MachO.LoadUpwardDylib,
]);
const FILE_TYPES: ReadonlyMap<number, MachOFileType> = new Map([
  [MachO.Execute, MachOFileType.Execute],
  [MachO.Dylib, MachOFileType.Dylib],
]);
/** Every Mach-O or universal magic, in either byte order: what makes an asset a program. */
const MACHO_MAGICS: ReadonlySet<number> = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca,
]);
/** The two universal (fat) magics, as written: big-endian. */
const FAT_MAGICS: ReadonlySet<number> = new Set([0xcafebabe, 0xcafebabf]);
/** Apple's OpenGL frameworks (and those built on it), in any case: the file system ignores it. */
const OPENGL_FRAMEWORK = /(^|\/)(opengl|agl|glut)\.framework(\/|$)/i;
/** `libGL.dylib`, `libGL.1.dylib`, `libGLU.dylib`: never `libGLESv2.dylib`. */
const LIBGL = /^libglu?(\.\d+)*\.dylib$/i;
/** OpenGL ES and GLKit besides Apple's OpenGL: no Rust game links either (a bundled ANGLE is a foreign import). */
const RUST_GL_FRAMEWORK = /(^|\/)(opengles|glkit)\.framework(\/|$)/i;
/**
 * A system framework by its install name: `/System/Library/Frameworks/<Name>.framework/<Name>`
 * (iOS, and the Mac's top-level link) or `…/Versions/<letter>/<Name>` (the Mac's own spelling).
 */
const SYSTEM_FRAMEWORK =
  /^\/System\/Library\/Frameworks\/([A-Za-z][A-Za-z0-9]*)\.framework\/(?:Versions\/[A-Z]\/)?([A-Za-z][A-Za-z0-9]*)$/;
/** The `/usr/lib` libraries a Rust game may link on either Apple destination: libSystem, the ObjC runtime, iconv, libc++. */
const APPLE_RUST_LIBRARIES: ReadonlySet<string> = new Set([
  "/usr/lib/libSystem.B.dylib",
  "/usr/lib/libobjc.A.dylib",
  "/usr/lib/libiconv.2.dylib",
  "/usr/lib/libc++.1.dylib",
]);
/**
 * The frameworks a Rust · wgpu game links on the Mac: what the M2 builds of winit, wgpu's Metal
 * backend, cpal, gilrs and arboard import (`tests/fixtures/rust-bundles/m2-binaries.json`), plus the
 * few their other paths may add. A new framework is a reviewed change to this list, never a pass.
 */
export const MAC_RUST_FRAMEWORKS: ReadonlySet<string> = new Set([
  "AppKit",
  "ApplicationServices",
  "AudioToolbox",
  "AudioUnit",
  "AVFoundation",
  "Carbon",
  "ColorSync",
  "CoreAudio",
  "CoreFoundation",
  "CoreGraphics",
  "CoreServices",
  "CoreText",
  "CoreVideo",
  "Foundation",
  "GameController",
  "IOKit",
  "IOSurface",
  "Metal",
  "QuartzCore",
  "UniformTypeIdentifiers",
]);
/** The frameworks a Rust · wgpu game links on iOS (device and Simulator), as {@link MAC_RUST_FRAMEWORKS} is chosen. */
export const IOS_RUST_FRAMEWORKS: ReadonlySet<string> = new Set([
  "AudioToolbox",
  "AVFAudio",
  "AVFoundation",
  "CoreAudio",
  "CoreFoundation",
  "CoreGraphics",
  "CoreHaptics",
  "CoreText",
  "CoreVideo",
  "Foundation",
  "GameController",
  "IOSurface",
  "Metal",
  "QuartzCore",
  "UIKit",
]);

/** Each Apple destination's Rust policy: the platforms its `LC_BUILD_VERSION` may name, its frameworks and its minimum OS. */
const RUST_APPLE_POLICY = {
  [BuildTarget.Mac]: { platforms: [ApplePlatformCode.MacOs], frameworks: MAC_RUST_FRAMEWORKS, minos: null },
  [BuildTarget.Ios]: {
    platforms: [ApplePlatformCode.Ios, ApplePlatformCode.IosSimulator],
    frameworks: IOS_RUST_FRAMEWORKS,
    minos: IOS_MINIMUM_OS_VERSION,
  },
} as const satisfies Record<
  AppleRustTarget,
  { platforms: readonly number[]; frameworks: ReadonlySet<string>; minos: string | null }
>;

/** The store's two ANGLE libraries, as the manifest names them and a bundle's `Frameworks/` holds them. */
export const MAC_ANGLE_FILES = { egl: "libEGL.dylib", gles: "libGLESv2.dylib" } as const;
const ANGLE_FILES = MAC_ANGLE_FILES;
const ANGLE_MANIFEST = "manifest.json";
/** The folders a run's `state/` starts with. */
const STATE_SUBFOLDERS = [RunDirLayout.Home, RunDirLayout.Captures] as const;
const DEFAULT_BUNDLE_NAME = "Game";
const ASSETS_FOLDER = "assets";
/** The host's `codesign`, by its absolute path: never one found on a search path. */
export const CODESIGN_PATH = "/usr/bin/codesign";
const CODESIGN = CODESIGN_PATH;
/** Ad-hoc signing with no network timestamp: a run's bundle is signed for this Mac only. */
const CODESIGN_ARGS = ["--force", "-s", "-", "--timestamp=none"] as const;

const notExecutable = (message: string) => new NativeError(NativeRefusal.NotAnExecutable, message);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The NUL-terminated string a load command at `at` points to, past its `fixed` part and within its own size. */
function commandString(bytes: Uint8Array, view: DataView, at: number, size: number, fixed: number): string {
  if (size < fixed) throw notExecutable(MESSAGE.BadString);
  const offset = view.getUint32(at + 8, true);
  if (offset < fixed || offset >= size) throw notExecutable(MESSAGE.BadString);
  const text = bytes.subarray(at + offset, at + size);
  const end = text.indexOf(0);
  if (end < 0) throw notExecutable(MESSAGE.BadString);
  try {
    return utf8.decode(text.subarray(0, end));
  } catch {
    throw notExecutable(MESSAGE.BadString);
  }
}

/** Records one load command's library, search path, id or loader setting into `image`. */
function readCommand(bytes: Uint8Array, view: DataView, at: number, image: MachOImage): void {
  const cmd = view.getUint32(at, true);
  const size = view.getUint32(at + 4, true);
  if (IMPORT_COMMANDS.has(cmd)) image.dylibs.push(commandString(bytes, view, at, size, MachO.DylibCommandBytes));
  else if (cmd === MachO.IdDylib) image.id = commandString(bytes, view, at, size, MachO.DylibCommandBytes);
  else if (cmd === MachO.Rpath) image.rpaths.push(commandString(bytes, view, at, size, MachO.PathCommandBytes));
  else if (cmd === MachO.DyldEnvironment) {
    image.environment.push(commandString(bytes, view, at, size, MachO.PathCommandBytes));
  }
}

/** The file type a thin arm64 Mach-O header names; refuses anything else. */
function headerFileType(bytes: Uint8Array, view: DataView): MachOFileType {
  if (bytes.byteLength < MachO.HeaderBytes) throw notExecutable(MESSAGE.Short);
  if (FAT_MAGICS.has(view.getUint32(0, false))) throw notExecutable(MESSAGE.Fat);
  if (view.getUint32(0, true) !== MachO.Magic64) throw notExecutable(MESSAGE.Magic);
  if (view.getUint32(4, true) !== MachO.CpuArm64) throw notExecutable(MESSAGE.NotArm64);
  const fileType = FILE_TYPES.get(view.getUint32(12, true));
  if (!fileType) throw notExecutable(MESSAGE.FileType);
  return fileType;
}

/**
 * The load commands of a thin arm64 Mach-O image. Every offset and size is checked against the
 * header and the bytes; anything that does not add up is `NativeError(NotAnExecutable)`.
 */
export function parseMachO(bytes: Uint8Array): MachOImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fileType = headerFileType(bytes, view);
  const count = view.getUint32(16, true);
  const commandBytes = view.getUint32(20, true);
  const end = MachO.HeaderBytes + commandBytes;
  const fits = commandBytes <= LOAD_COMMANDS_MAX_BYTES && end <= bytes.byteLength;
  if (!fits || count * MachO.MinCommandBytes > commandBytes) throw notExecutable(MESSAGE.Commands);
  const image: MachOImage = { fileType, dylibs: [], rpaths: [], id: null, environment: [] };
  let at = MachO.HeaderBytes;
  for (let index = 0; index < count; index++) {
    if (at + MachO.MinCommandBytes > end) throw notExecutable(MESSAGE.Commands);
    const size = view.getUint32(at + 4, true);
    const aligned = size >= MachO.MinCommandBytes && size % MachO.CommandAlign === 0;
    if (!aligned || at + size > end) throw notExecutable(MESSAGE.Commands);
    readCommand(bytes, view, at, image);
    at += size;
  }
  return image;
}

/** Mach-O's packed version (`xxxx.yy.zz`) as text, the patch only when it is not zero. */
function machOVersionText(packed: number): string {
  const [major, minor, patch] = [packed >>> 16, (packed >>> 8) & 0xff, packed & 0xff];
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

/**
 * Every `LC_BUILD_VERSION` of a Mach-O image {@link parseMachO} has read (its commands fit their
 * area), in file order; throws `NativeError(NotAnExecutable)` for one shorter than its fields.
 */
export function readBuildVersions(bytes: Uint8Array): MachOBuildVersion[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(16, true);
  const versions: MachOBuildVersion[] = [];
  let at = MachO.HeaderBytes;
  for (let index = 0; index < count; index++) {
    const size = view.getUint32(at + 4, true);
    if (view.getUint32(at, true) === MachO.BuildVersion) {
      if (size < MachO.BuildVersionBytes) throw notExecutable(MESSAGE.BuildVersionShort);
      versions.push({ platform: view.getUint32(at + 8, true), minos: machOVersionText(view.getUint32(at + 12, true)) });
    }
    at += size;
  }
  return versions;
}

/** The refusal an open of an agent-made file gets: a link is `Symlink`, anything else `NotAnExecutable`. */
function openRefusal(file: string, error: unknown): NativeError {
  if ((error as NodeJS.ErrnoException).code === "ELOOP")
    return new NativeError(NativeRefusal.Symlink, MESSAGE.Link(file));
  return notExecutable(MESSAGE.Unreadable(file, errorMessage(error)));
}

/** Reads `handle` whole: at most `size` bytes, fewer if the file shrank meanwhile. */
async function readAll(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let total = 0;
  while (total < size) {
    const { bytesRead } = await handle.read(bytes, total, size - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return bytes.subarray(0, total);
}

/**
 * A file in a folder someone else writes, read whole: never through a link, never blocking on a
 * FIFO (opened non-blocking, then required to be a regular file) and never past `maxBytes`.
 */
async function readUntrusted(file: string, maxBytes: number): Promise<{ bytes: Buffer; info: Stats }> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK).catch((error: unknown) => {
    throw openRefusal(file, error);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notExecutable(MESSAGE.NotRegular(file));
    if (info.size > maxBytes) throw notExecutable(MESSAGE.TooLarge(file, maxBytes));
    return { bytes: await readAll(handle, info.size), info };
  } finally {
    await handle.close();
  }
}

/** The load commands of the thin arm64 Mach-O at `file`; throws `NativeError` (`Symlink`, `NotAnExecutable`). */
export async function readMachO(file: string, maxBytes: number = EXECUTABLE_MAX_BYTES): Promise<MachOImage> {
  return parseMachO((await readUntrusted(file, maxBytes)).bytes);
}

/** Whether an install name is Apple's OpenGL or a libGL: link-time imports are the gate's only signal. */
function isOpenGl(installName: string): boolean {
  return OPENGL_FRAMEWORK.test(installName) || LIBGL.test(path.posix.basename(installName));
}

/** Refuses an image that is not a game executable importing the bundled ANGLE through the one rpath. */
function assertGameImage(image: MachOImage, file: string): void {
  if (image.fileType !== MachOFileType.Execute) throw notExecutable(MESSAGE.NotExecutable(file));
  const openGl = image.dylibs.find(isOpenGl);
  if (openGl) throw new NativeError(NativeRefusal.LinksOpenGl, MESSAGE.OpenGl(openGl));
  const missing = MAC_ANGLE_IMPORTS.find((name) => !image.dylibs.includes(name));
  if (missing) throw new NativeError(NativeRefusal.MissingAngleImport, MESSAGE.MissingAngle(missing));
  const onlyRpath = image.rpaths.length === 1 && image.rpaths[0] === MAC_GAME_RPATH;
  if (!onlyRpath) throw new NativeError(NativeRefusal.ForeignRpath, MESSAGE.ForeignRpath(image.rpaths));
  if (image.environment.length > 0) throw new NativeError(NativeRefusal.ForeignRpath, MESSAGE.DyldEnvironment);
}

const rustRefused = (refusal: NativeRefusal, problem: RustAdmissionProblem, detail: string): RustBinaryRefusal => ({
  ok: false,
  refusal,
  problem,
  detail,
});

/** Whether an install name is a system GL a Rust game never links: Apple's OpenGL, OpenGL ES or GLKit. */
function isRustGl(installName: string): boolean {
  return isOpenGl(installName) || RUST_GL_FRAMEWORK.test(installName);
}

/** Whether an install name is an allowed `/usr/lib` library or a framework in `frameworks`, by its exact system path. */
function isAllowedAppleImport(installName: string, frameworks: ReadonlySet<string>): boolean {
  if (APPLE_RUST_LIBRARIES.has(installName)) return true;
  const match = SYSTEM_FRAMEWORK.exec(installName);
  return match !== null && match[1] === match[2] && frameworks.has(match[1] ?? "");
}

/** Why the one build version is not `target`'s (a platform it does not name, an iOS minimum but 16.0), or null. */
function versionRefusal(versions: readonly MachOBuildVersion[], target: AppleRustTarget): RustBinaryRefusal | null {
  const policy = RUST_APPLE_POLICY[target];
  const [version] = versions;
  if (versions.length !== 1 || !version) {
    return rustRefused(NativeRefusal.WrongMachine, RustAdmissionProblem.WrongPlatform, MESSAGE.NoBuildVersion(target));
  }
  if (!(policy.platforms as readonly number[]).includes(version.platform)) {
    const detail = MESSAGE.WrongPlatform(version.platform, target);
    return rustRefused(NativeRefusal.WrongMachine, RustAdmissionProblem.WrongPlatform, detail);
  }
  if (policy.minos !== null && version.minos !== policy.minos) {
    return rustRefused(NativeRefusal.WrongMachine, RustAdmissionProblem.MinosMismatch, MESSAGE.Minos(version.minos));
  }
  return null;
}

/** Why a Rust image's imports, search paths or loader settings are not `target`'s, or null. */
function importRefusal(image: MachOImage, target: AppleRustTarget): RustBinaryRefusal | null {
  const gl = image.dylibs.find(isRustGl);
  if (gl) return rustRefused(NativeRefusal.LinksOpenGl, RustAdmissionProblem.OpenGl, MESSAGE.RustGl(gl));
  const { frameworks } = RUST_APPLE_POLICY[target];
  const foreign = image.dylibs.find((name) => !isAllowedAppleImport(name, frameworks));
  if (foreign) {
    const detail = MESSAGE.RustForeign(foreign, target);
    return rustRefused(NativeRefusal.ForeignImport, RustAdmissionProblem.ForeignImport, detail);
  }
  if (image.rpaths.length > 0) {
    return rustRefused(NativeRefusal.ForeignRpath, RustAdmissionProblem.SearchPath, MESSAGE.RustRpath(image.rpaths));
  }
  if (image.environment.length > 0) {
    return rustRefused(NativeRefusal.ForeignRpath, RustAdmissionProblem.DyldEnvironment, MESSAGE.DyldEnvironment);
  }
  return null;
}

/** The Rust policy over a read image: an executable, `target`'s platform and minimum OS, then its imports. */
function rustImageRefusal(
  image: MachOImage,
  versions: readonly MachOBuildVersion[],
  target: AppleRustTarget,
): RustBinaryRefusal | null {
  if (image.fileType !== MachOFileType.Execute) {
    const detail = MESSAGE.NotExecutable("the image");
    return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.NotAnExecutable, detail);
  }
  return versionRefusal(versions, target) ?? importRefusal(image, target);
}

/**
 * Admits a Rust · wgpu game's Mac or iOS executable from its bytes (M3.5): a thin arm64 Mach-O
 * executable whose one `LC_BUILD_VERSION` names the destination's platform (iOS: device or
 * Simulator, minos {@link IOS_MINIMUM_OS_VERSION}), importing only allow-listed system frameworks
 * and `/usr/lib` libraries (no dylib of its own, no GL of any kind), with no rpath and no
 * `LC_DYLD_ENVIRONMENT`. Pure; never throws.
 */
export function admitRustMachO(bytes: Uint8Array, target: AppleRustTarget): RustMachOAdmission {
  let image: MachOImage;
  let versions: MachOBuildVersion[];
  try {
    image = parseMachO(bytes);
    versions = readBuildVersions(bytes);
  } catch (error) {
    return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.Unreadable, errorMessage(error));
  }
  const refusal = rustImageRefusal(image, versions, target);
  if (refusal) return refusal;
  return { ok: true, image, version: versions[0] ?? { platform: 0, minos: "" } };
}

/** Refuses an image that is not a Rust · wgpu Mac executable, by the Rust Mac policy ({@link admitRustMachO}). */
function assertWgpuImage(image: MachOImage, _file: string, bytes: Uint8Array): void {
  const refusal = rustImageRefusal(image, readBuildVersions(bytes), BuildTarget.Mac);
  if (refusal) throw new NativeError(refusal.refusal, refusal.detail);
}

/** How an executable's image is checked: a raylib game's (ANGLE) or a wgpu game's (the Rust Mac policy). */
type ImageCheck = (image: MachOImage, file: string, bytes: Uint8Array) => void;

/** An executable's bytes, read and checked by `check`: not a link, no second hard link. */
async function readCheckedExecutable(file: string, check: ImageCheck): Promise<{ bytes: Buffer; image: MachOImage }> {
  const { bytes, info } = await readUntrusted(file, EXECUTABLE_MAX_BYTES);
  assertOneLink(info, file);
  const image = parseMachO(bytes);
  check(image, file, bytes);
  return { bytes, image };
}

/** An executable's bytes, read and checked as a game: not a link, no second hard link, a game image. */
export async function readGameExecutable(file: string): Promise<{ bytes: Buffer; image: MachOImage }> {
  return readCheckedExecutable(file, assertGameImage);
}

/** A wgpu game executable's bytes, read and checked: not a link, no second hard link, system imports only. */
export async function readWgpuExecutable(file: string): Promise<{ bytes: Buffer; image: MachOImage }> {
  return readCheckedExecutable(file, assertWgpuImage);
}

/** Whether `bytes` start with a Mach-O or universal magic. */
function isMachO(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return MACHO_MAGICS.has(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false));
}

/**
 * macOS's `O_NOFOLLOW_ANY` (not in Node's constants): an open fails with ELOOP when any part of the
 * path is a link, not only its last. An asset is opened this way under its folder's real path, so a
 * folder of `out/` swapped for a link while the host copies is refused, never followed.
 */
const O_NOFOLLOW_ANY = 0x20000000;

/**
 * How an asset is opened: no link at its name and, on macOS, none anywhere on its path. macOS
 * refuses `O_NOFOLLOW` beside `O_NOFOLLOW_ANY` (EINVAL); the latter covers the name too.
 */
const ASSET_NO_FOLLOW = process.platform === "darwin" ? O_NOFOLLOW_ANY : FS.O_NOFOLLOW;

/** One asset as the listing saw it: its path under the assets folder and the file it was (device and inode). */
export interface ListedAsset {
  rel: string;
  dev: number;
  ino: number;
}

/** Refuses a file with a second hard link: its bytes could be another file's, one the bundle must not carry. */
function assertOneLink(info: Stats, file: string): void {
  if (info.nlink > 1) throw new NativeError(NativeRefusal.HardLink, MESSAGE.HardLink(file));
}

/**
 * An asset's first bytes and which file it is, read without following a link (on macOS, anywhere
 * on its path) or blocking; null when it is not a regular file. One with a second hard link is refused.
 */
async function assetHead(file: string): Promise<{ head: Buffer; info: Stats } | null> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK, undefined, ASSET_NO_FOLLOW).catch(
    (error: unknown) => {
      throw openRefusal(file, error);
    },
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    assertOneLink(info, file);
    return { head: await readAll(handle, 4), info };
  } finally {
    await handle.close();
  }
}

/**
 * What one entry under `assets/` adds: a regular file as listed, a folder to look into, or
 * nothing (a FIFO, a socket, a device). A link is `Symlink`, a Mach-O or universal file `ExtraMachO`.
 */
async function assetEntry(
  assets: string,
  rel: string,
  entry: Dirent,
): Promise<{ file?: ListedAsset; folder?: string }> {
  const child = rel ? path.join(rel, entry.name) : entry.name;
  if (entry.isSymbolicLink()) throw new NativeError(NativeRefusal.Symlink, MESSAGE.Link(path.join(assets, child)));
  if (entry.isDirectory()) return { folder: child };
  if (!entry.isFile()) return {};
  const found = await assetHead(path.join(assets, child));
  if (found && isMachO(found.head)) throw new NativeError(NativeRefusal.ExtraMachO, MESSAGE.ExtraMachO(child));
  return found ? { file: { rel: child, dev: found.info.dev, ino: found.info.ino } } : {};
}

/** The regular files under an `assets/` folder, by relative path; see {@link assetEntry} for what is refused. */
async function assetFiles(assets: string): Promise<ListedAsset[]> {
  if ((await lstat(assets)).isSymbolicLink()) throw new NativeError(NativeRefusal.Symlink, MESSAGE.Link(assets));
  const files: ListedAsset[] = [];
  const folders = [""];
  for (let rel = folders.pop(); rel !== undefined; rel = folders.pop()) {
    for (const entry of await readdir(path.join(assets, rel), { withFileTypes: true })) {
      const found = await assetEntry(assets, rel, entry);
      if (found.folder !== undefined) folders.push(found.folder);
      if (found.file !== undefined) files.push(found.file);
    }
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : Number(a.rel > b.rel)));
}

/**
 * `assets` by its real path, refused when `out/` or `assets/` itself is a link: the build folder
 * above them is the host's, but a build run can replace anything inside it. Only links above the
 * build folder (macOS's `/var`, say) are resolved, so a later open that meets any link fails.
 */
async function realAssetsRoot(assets: string): Promise<string> {
  const out = path.dirname(assets);
  const expected = path.join(await realpath(path.dirname(out)), path.basename(out), path.basename(assets));
  const real = await realpath(assets);
  if (real !== expected) throw new NativeError(NativeRefusal.Symlink, MESSAGE.Link(assets));
  return real;
}

/** An admitted `assets/` folder by its real path, and its regular files as they were listed. */
export interface AssetListing {
  root: string;
  files: ListedAsset[];
}

/**
 * The admitted `assets/` listed again for a copy (null when the build has none): by its real path,
 * every file as it is now. Throws the typed refusal (`Symlink`, `HardLink`, `ExtraMachO`).
 */
export async function listAdmittedAssets(assets: string | null): Promise<AssetListing | null> {
  if (!assets) return null;
  const root = await refusing(realAssetsRoot(assets));
  return { root, files: await refusing(assetFiles(root)) };
}

/** Copies every listed asset into `toDir` with {@link copyAsset}'s checks; a refused one throws the typed refusal. */
export async function copyListedAssets(listing: AssetListing, toDir: string): Promise<void> {
  for (const listed of listing.files) {
    await copyAsset(path.join(listing.root, listed.rel), path.join(toDir, listed.rel), listed);
  }
}

/**
 * A file in a folder someone else writes, read whole as {@link copyAsset} reads one: no link
 * anywhere on its path (on macOS), never blocking, a regular file of at most `maxBytes` with no
 * second hard link. Throws the typed refusal.
 */
export async function readAssetFile(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK, undefined, ASSET_NO_FOLLOW).catch(
    (error: unknown) => {
      throw openRefusal(file, error);
    },
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notExecutable(MESSAGE.NotRegular(file));
    if (info.size > maxBytes) throw notExecutable(MESSAGE.TooLarge(file, maxBytes));
    assertOneLink(info, file);
    return await readAll(handle, info.size);
  } finally {
    await handle.close();
  }
}

/** A host-owned file (the toolchain store's), read whole: never through a link at its name, never past `maxBytes`. */
export async function readHostFile(file: string, maxBytes: number): Promise<Buffer> {
  return (await readUntrusted(file, maxBytes)).bytes;
}

/** The staged `assets/` beside the executables, or null when there is no such folder. */
async function admittedAssets(outDir: string): Promise<string | null> {
  const assets = path.join(outDir, ASSETS_FOLDER);
  const info = await lstat(assets).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink()) throw new NativeError(NativeRefusal.Symlink, MESSAGE.Link(assets));
  if (!info.isDirectory()) return null;
  await assetFiles(await realAssetsRoot(assets));
  return assets;
}

/** The executable a Mac build leaves for `mode`; an embedded run has none. */
function executableName(mode: NativeRunMode): string {
  if (mode === NativeRunMode.Window || mode === NativeRunMode.Headless) return NATIVE_MAC_EXECUTABLES[mode];
  throw new NativeError(NativeRefusal.Unsupported, MESSAGE.NoExecutable(mode));
}

/** Folds any other failure into the typed refusal: what cannot be checked is not admitted. */
function asRefusal(error: unknown): NativeError {
  return error instanceof NativeError ? error : notExecutable(errorMessage(error));
}

/** `work`'s result, or its failure as the typed refusal. */
async function refusing<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw asRefusal(error);
  }
}

/** Admits the executable for `mode` from a Mac build's `out/` through `check`, with the staged assets. */
async function admitChecked(outDir: string, mode: NativeRunMode, check: ImageCheck): Promise<MacAdmission> {
  try {
    const exe = path.join(outDir, executableName(mode));
    const { image } = await readCheckedExecutable(exe, check);
    const assets = await admittedAssets(outDir);
    return { ok: true, bundle: { mode, exe, image, assets } };
  } catch (error) {
    const refused = asRefusal(error);
    return { ok: false, refusal: refused.refusal, detail: refused.message };
  }
}

/** Admits the executable for `options.mode` from a Mac build's `out/`, or names why not. Writes nothing. */
export async function admitMacBundle(outDir: string, options: { mode: NativeRunMode }): Promise<MacAdmission> {
  return admitChecked(outDir, options.mode, assertGameImage);
}

/**
 * Admits a Rust · wgpu game's executable for `options.mode` from its Mac build's `out/`: thin
 * arm64, system imports only, no OpenGL, rpath or loader setting; the assets as a raylib game's.
 * Writes nothing.
 */
export async function admitWgpuBundle(outDir: string, options: { mode: NativeRunMode }): Promise<MacAdmission> {
  return admitChecked(outDir, options.mode, assertWgpuImage);
}

/** A manifest's `files` entry for one library: its digest and size. */
interface PinnedFile {
  sha256: string;
  size: number;
}

/** What `manifest.json` pins for `name`, or null. */
function pinnedFile(manifest: unknown, name: string): PinnedFile | null {
  const files = isJsonObject(manifest) ? manifest.files : null;
  const entry = isJsonObject(files) ? files[name] : null;
  if (!isJsonObject(entry) || typeof entry.sha256 !== "string" || typeof entry.size !== "number") return null;
  return { sha256: entry.sha256, size: entry.size };
}

/** One store library's bytes, refused unless they are exactly what the manifest pins and link no OpenGL. */
async function angleLibrary(file: string, pin: PinnedFile | null, name: string): Promise<Buffer> {
  const refused = new NativeError(NativeRefusal.AngleDigest, MESSAGE.AngleLibrary(name));
  const read = await readUntrusted(file, ANGLE_LIBRARY_MAX_BYTES).catch(() => null);
  if (!pin || !read || read.bytes.length !== pin.size || sha256(read.bytes) !== pin.sha256) throw refused;
  let image: MachOImage;
  try {
    image = parseMachO(read.bytes);
  } catch {
    throw refused;
  }
  if (image.fileType !== MachOFileType.Dylib) throw refused;
  const openGl = image.dylibs.find(isOpenGl);
  if (openGl) throw new NativeError(NativeRefusal.LinksOpenGl, MESSAGE.OpenGl(openGl));
  return read.bytes;
}

/** The store's two ANGLE libraries, read once and checked: the manifest is the pin, each library its manifest's. */
export async function readMacAngle(angle: MacAngle): Promise<{ egl: Buffer; gles: Buffer }> {
  const read = await readUntrusted(path.join(angle.dir, ANGLE_MANIFEST), ANGLE_MANIFEST_MAX_BYTES).catch(() => null);
  if (!read || sha256(read.bytes) !== angle.manifestSha256) {
    throw new NativeError(NativeRefusal.AngleDigest, MESSAGE.AngleManifest);
  }
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    throw new NativeError(NativeRefusal.AngleDigest, MESSAGE.AngleManifest);
  }
  const egl = await angleLibrary(angle.egl, pinnedFile(manifest, ANGLE_FILES.egl), ANGLE_FILES.egl);
  const gles = await angleLibrary(angle.gles, pinnedFile(manifest, ANGLE_FILES.gles), ANGLE_FILES.gles);
  return { egl, gles };
}

/** Null when the store's ANGLE is the pinned Metal-only build (digest, imports); else the refusal. */
export async function checkMacAngle(angle: MacAngle): Promise<NativeRefusal | null> {
  try {
    await readMacAngle(angle);
    return null;
  } catch (error) {
    return asRefusal(error).refusal;
  }
}

/** `text` as plist string content: the five XML specials escaped, control characters dropped, cut to 64 characters. */
export function plistText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this drops.
  const plain = text.replace(/[\x00-\x1f\x7f]/g, "").slice(0, BUNDLE_NAME_MAX_CHARS);
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
  return plain.replace(/[&<>"']/g, (character) => entities[character] ?? "");
}

/** One `Info.plist` key and its value's XML (`<string>…</string>`, `<true/>`), in the order written. */
export type PlistEntry = readonly [key: string, valueXml: string];

/** A plist value holding `text` as host text (see {@link plistText}). */
export function plistString(text: string): string {
  return `<string>${plistText(text)}</string>`;
}

/** An `Info.plist` document holding `entries` in order: host text only, nothing from the build. */
export function plistDocument(entries: readonly PlistEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries.flatMap(([key, value]) => [`\t<key>${key}</key>`, `\t${value}`]),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The entries every Genex-assembled bundle opens with: what it runs, who it is and what it needs. */
export function bundleIdentityEntries(bundleId: string, name: string): PlistEntry[] {
  return [
    ["CFBundleExecutable", `<string>${RunDirLayout.Executable}</string>`],
    ["CFBundleIdentifier", `<string>${bundleId}</string>`],
    ["CFBundleInfoDictionaryVersion", "<string>6.0</string>"],
    ["CFBundleName", `<string>${plistText(name) || DEFAULT_BUNDLE_NAME}</string>`],
    ["CFBundlePackageType", "<string>APPL</string>"],
    ["LSMinimumSystemVersion", `<string>${MAC_MINIMUM_SYSTEM_VERSION}</string>`],
    ["NSHighResolutionCapable", "<true/>"],
  ];
}

/** The run bundle's `Info.plist`: host text only, nothing from the build. */
function infoPlist(bundleId: string, name: string, uiElement: boolean): string {
  const background: PlistEntry[] = uiElement ? [["LSUIElement", "<true/>"]] : [];
  return plistDocument([...bundleIdentityEntries(bundleId, name), ...background]);
}

/**
 * Copies one asset without following a link (on macOS, anywhere on its path); refuses a file that
 * is not the one the listing saw (a folder on its way swapped, the file replaced), or that became a
 * Mach-O, or gained a second hard link, since.
 */
async function copyAsset(from: string, to: string, listed: ListedAsset, expected: string | null = null): Promise<void> {
  const { rel } = listed;
  const source = await openNoFollow(from, FS.O_RDONLY | FS.O_NONBLOCK, undefined, ASSET_NO_FOLLOW).catch(
    (error: unknown) => {
      throw openRefusal(from, error);
    },
  );
  try {
    const info = await source.stat();
    const same = info.isFile() && info.dev === listed.dev && info.ino === listed.ino;
    if (!same) throw new NativeError(NativeRefusal.Symlink, MESSAGE.Changed(rel));
    assertOneLink(info, rel);
    await mkdir(path.dirname(to), { recursive: true });
    const target = await open(to, "wx", 0o644);
    try {
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
      for (let first = true; ; first = false) {
        const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        if (first && isMachO(chunk.subarray(0, bytesRead))) {
          throw new NativeError(NativeRefusal.ExtraMachO, MESSAGE.ExtraMachO(rel));
        }
        hash.update(chunk.subarray(0, bytesRead));
        await target.write(chunk, 0, bytesRead);
      }
      // The bytes copied, not the file: a write in place after the listing is caught here.
      if (expected !== null && hash.digest("hex") !== expected) throw notExecutable(MESSAGE.NotAdmitted(rel));
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/** What a bundle is written from: bytes already checked, and the asset files listed. */
interface BundleParts {
  exe: Buffer;
  /** The lane's admitted digests by `/`-separated path under `out/`: each asset copied must match; null checks none. */
  digests: ReadonlyMap<string, string> | null;
  /** The store's ANGLE for a raylib game; null for a wgpu game, whose bundle has no `Frameworks/`. */
  angle: { egl: Buffer; gles: Buffer } | null;
  assets: { root: string; files: ListedAsset[] } | null;
  plist: string;
}

/** The store's two ANGLE libraries into the app's `Frameworks/`. */
async function writeAngle(contents: string, angle: { egl: Buffer; gles: Buffer }): Promise<void> {
  await mkdir(path.join(contents, "Frameworks"), { mode: 0o700 });
  await writeFile(path.join(contents, "Frameworks", ANGLE_FILES.egl), angle.egl, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(contents, "Frameworks", ANGLE_FILES.gles), angle.gles, { flag: "wx", mode: 0o600 });
}

/** Writes `bundle/Game.app` and `state/` into a fresh run directory; returns the app's `Contents`. */
async function writeRunDir(runDir: string, parts: BundleParts): Promise<string> {
  const contents = path.join(runDir, RunDirLayout.Bundle, NATIVE_BUNDLE_APP, "Contents");
  for (const folder of ["MacOS", path.join("Resources", ASSETS_FOLDER)]) {
    await mkdir(path.join(contents, folder), { recursive: true, mode: 0o700 });
  }
  await writeFile(path.join(contents, "MacOS", RunDirLayout.Executable), parts.exe, { flag: "wx", mode: 0o700 });
  if (parts.angle) await writeAngle(contents, parts.angle);
  await writeFile(path.join(contents, "Info.plist"), parts.plist, { flag: "wx", mode: 0o600 });
  for (const listed of parts.assets?.files ?? []) {
    const root = parts.assets?.root ?? "";
    const expected = parts.digests?.get(admittedAssetPath(listed.rel)) ?? null;
    const to = path.join(contents, "Resources", ASSETS_FOLDER, listed.rel);
    await copyAsset(path.join(root, listed.rel), to, listed, expected);
  }
  const state = path.join(runDir, RunDirLayout.State);
  await mkdir(state, { mode: 0o700 });
  for (const folder of STATE_SUBFOLDERS) await mkdir(path.join(state, folder), { mode: 0o700 });
  await chmod(state, 0o700);
  return contents;
}

/**
 * `codesign --force -s - --timestamp=none` on each bundled library, then the app: inside out, as
 * nested code must be. A bundle with no `Frameworks/` (a wgpu game's) signs the app alone.
 */
async function signInsideOut(exec: BundleExec, contents: string, libraries: boolean): Promise<void> {
  const frameworks = path.join(contents, "Frameworks");
  const nested = libraries ? [path.join(frameworks, ANGLE_FILES.egl), path.join(frameworks, ANGLE_FILES.gles)] : [];
  const targets = [...nested, path.dirname(contents)];
  for (const target of targets) {
    const signed = await exec(CODESIGN, [...CODESIGN_ARGS, target]);
    if (signed.code !== 0) throw notExecutable(MESSAGE.Unsigned(target, signed.stderr.trim()));
  }
}

/** Makes `dir` and everything in it read-only: folders and executables `r-x`, other files `r--`. */
async function makeReadOnly(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await makeReadOnly(full);
    else if (entry.isFile()) await chmod(full, ((await lstat(full)).mode & 0o100) !== 0 ? 0o555 : 0o444);
  }
  await chmod(dir, 0o555);
}

/** Refuses a run id or bundle id the run directory and `Info.plist` cannot carry. */
function assertRunNames(request: Pick<RunDirRequest, "runId" | "bundleId">): void {
  if (!isRunId(request.runId)) throw new NativeError(NativeRefusal.Unsupported, MESSAGE.BadRunId);
  if (!isBundleId(request.bundleId)) throw new NativeError(NativeRefusal.Unsupported, MESSAGE.BadBundleId);
}

/** Makes `<root>/<runId>` (host-only), refusing one that exists already; returns its real path. */
async function createRunDir(root: string, runId: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const runDir = path.join(await realpath(root), runId);
  await mkdir(runDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EEXIST" ? new NativeError(NativeRefusal.Unsupported, MESSAGE.RunDirTaken(runDir)) : error;
  });
  await chmod(runDir, 0o700);
  return runDir;
}

/**
 * Assembles `Game.app` in `<root>/<runId>`: everything is read and checked first (the store's
 * ANGLE against the pin, the executable and every asset again), then written, signed inside out
 * and made read-only. Throws `NativeError` and leaves no run directory behind.
 */
export async function assembleRunDir(request: RunDirRequest): Promise<AssembledRunDir> {
  assertRunNames(request);
  const angle = await readMacAngle(request.angle);
  const { bytes: exe } = await refusing(readGameExecutable(request.admitted.exe));
  return assembleChecked(request, { exe, angle, digests: null });
}

/** One file of a lane's admitted `out/`: its `/`-separated path and sha256 (the Rust receipt's `outputs`). */
export interface AdmittedOutputFile {
  path: string;
  sha256: string;
}

/**
 * What a wgpu game's run directory is assembled from: a raylib game's request with no ANGLE, and
 * the digests the lane recorded when it admitted `out/`.
 */
export interface WgpuRunDirRequest extends Omit<RunDirRequest, "angle"> {
  /** The lane's admitted files; the run is assembled from these very bytes or not at all. */
  admittedFiles: readonly AdmittedOutputFile[];
}

/** An asset's path in the lane's admitted digests: under `assets/`, `/`-separated. */
function admittedAssetPath(rel: string): string {
  return [ASSETS_FOLDER, ...rel.split(path.sep)].join("/");
}

/**
 * Refuses an executable whose bytes are not the ones the lane admitted under its name, and an
 * asset listing that is not exactly the admitted set (one added or removed after admission).
 */
function assertAdmitted(
  digests: ReadonlyMap<string, string>,
  exe: { name: string; bytes: Buffer },
  assets: readonly ListedAsset[],
): void {
  if (digests.get(exe.name) !== sha256(exe.bytes)) throw notExecutable(MESSAGE.NotAdmitted(exe.name));
  const listed = new Set(assets.map((asset) => admittedAssetPath(asset.rel)));
  const recorded = [...digests.keys()].filter((file) => file.startsWith(`${ASSETS_FOLDER}/`));
  const differ = [...recorded.filter((file) => !listed.has(file)), ...[...listed].filter((file) => !digests.has(file))];
  if (differ.length > 0) throw notExecutable(MESSAGE.AdmittedSet(differ.sort()));
}

/**
 * Assembles a Rust · wgpu game's `Game.app` in `<root>/<runId>`: the executable and every asset
 * read and checked again (system imports only), then written with a host-written `Info.plist`,
 * the app signed ad hoc and made read-only. No `Frameworks/`. Throws `NativeError` and leaves no
 * run directory behind.
 */
export async function assembleWgpuRunDir(request: WgpuRunDirRequest): Promise<AssembledRunDir> {
  assertRunNames(request);
  const { bytes: exe } = await refusing(readWgpuExecutable(request.admitted.exe));
  const digests = new Map(request.admittedFiles.map((file) => [file.path, file.sha256]));
  const name = path.basename(request.admitted.exe);
  return assembleChecked(request, { exe, angle: null, digests }, (files) =>
    assertAdmitted(digests, { name, bytes: exe }, files),
  );
}

/** The run directory from an executable (and ANGLE) already read and checked: assets, plist, writes, signing. */
async function assembleChecked(
  request: Omit<RunDirRequest, "angle">,
  checked: Pick<BundleParts, "exe" | "angle" | "digests">,
  checkListing: (files: readonly ListedAsset[]) => void = () => {},
): Promise<AssembledRunDir> {
  const { admitted } = request;
  const assetsRoot = admitted.assets ? await refusing(realAssetsRoot(admitted.assets)) : null;
  const files = assetsRoot ? await refusing(assetFiles(assetsRoot)) : [];
  checkListing(files);
  const uiElement = request.uiElement || admitted.mode === NativeRunMode.Headless;
  const plist = infoPlist(request.bundleId, request.gameName ?? DEFAULT_BUNDLE_NAME, uiElement);
  const runDir = await createRunDir(request.root, request.runId);
  try {
    await request.afterListing?.();
    const assets = assetsRoot ? { root: assetsRoot, files } : null;
    const contents = await writeRunDir(runDir, { ...checked, assets, plist });
    await signInsideOut(request.exec, contents, checked.angle !== null);
    await makeReadOnly(path.join(runDir, RunDirLayout.Bundle));
    return {
      runDir,
      exe: path.join(contents, "MacOS", RunDirLayout.Executable),
      bundle: path.join(runDir, RunDirLayout.Bundle),
      state: path.join(runDir, RunDirLayout.State),
    };
  } catch (error) {
    await removeRunDir(runDir);
    throw asRefusal(error);
  }
}

/** Gives every folder under `dir` its owner's write bit back, never following a link. */
async function makeRemovable(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeRemovable(path.join(dir, entry.name));
  }
}

/**
 * Removes a run directory whole: its bundle is read-only, so each folder gets its write bit back
 * first (links are never followed). Refuses a folder whose name is not a run id.
 */
export async function removeRunDir(runDir: string): Promise<void> {
  if (!isRunId(path.basename(runDir))) throw new NativeError(NativeRefusal.Unsupported, MESSAGE.NotARunDir(runDir));
  const info = await lstat(runDir).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) await makeRemovable(runDir);
  await rm(runDir, { recursive: true, force: true });
}
