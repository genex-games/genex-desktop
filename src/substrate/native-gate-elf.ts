/**
 * Admission of a Linux build of a C++ · raylib game (plan D17 = B, §3.9 and §8.7 "Windows and
 * Linux host gates", M4b). A build's output is agent-made, so the host reads each ELF itself: a
 * bounded pure-TS ELF64 reader that takes the dynamic array, string table and `.gnu.version_r`
 * through the loaded segments, as the dynamic loader does, and refuses anything malformed with a
 * typed reason. A bundle is admitted only when:
 * - the executable is a plain file name at the bundle root (no folder, no host file's name, no
 *   `.so` name), x86_64, and starts through `/lib64/ld-linux-x86-64.so.2`;
 * - it imports the bundled ANGLE (`libGLESv2.so` or `libEGL.so`), no system GL (`libGL.so.1`, GLX,
 *   libOpenGL, glvnd's `libEGL.so.1`/`libGLESv2.so.2`) and otherwise only glibc's own libraries,
 *   and names no library through `DT_FILTER`, `DT_AUXILIARY`, `DT_AUDIT` or `DT_DEPAUDIT` (which
 *   glibc also loads); any dynamic tag a linker does not write into a game is refused;
 * - its `DT_RUNPATH` is exactly `$ORIGIN` and it has no `DT_RPATH`: the export layout puts the
 *   host's files beside the executable at the bundle root, with no `lib/` folder;
 * - no ELF in the bundle needs a glibc symbol version above 2.28 (`GLIBC_PRIVATE`,
 *   `GLIBC_ABI_DT_RELR` and other unnumbered versions count as too new), and a game that needs a
 *   glibc library declares at least one `GLIBC_` version;
 * - the bundle, which the gate lists itself, carries no other ELF or shared object, and a host
 *   file (ANGLE, the Vulkan loader, SwiftShader, its ICD file) only byte-identical to the store's
 *   pinned copy, which assembly writes over it anyway;
 * - every entry is a regular file reached without a link, and none is a hard link.
 * The bundle is listed through the shared bounded walk (`bundle-walk.ts`: 10,000 entries, 32
 * folders deep, links never followed, FIFOs never opened, names one only by case or Unicode form
 * refused), and each file opened again without following a link. A game for another machine than
 * x86_64 is `wrong-machine`; a library neither glibc nor the bundle provides is `foreign-import`.
 * The reader also refuses a file whose loaded segments the loader would map differently from the
 * file view it parses (page-misaligned loads, two loads mapping one page from different file
 * pages, program headers outside the loaded bytes).
 * Admission reads and never writes. It checks link-time imports only: a game can still dlopen
 * anything at run time, which is the game box's business (M7), not this gate's. In particular
 * raylib's GLFW picks its EGL at run time by dlopen; that it opens the bundled `libEGL.so` and not
 * the system's `libEGL.so.1` is a guarantee of the Linux raylib prebuild (`_GLFW_EGL_LIBRARY`,
 * `_GLFW_GLESV2_LIBRARY`), which this gate cannot see. Per-symbol versions are not read either: a
 * versioned game can still carry an unversioned reference to a newer glibc symbol, which fails
 * to start on an older system rather than escaping the bundle.
 *
 * A Rust · wgpu game's executables have their own policies over the same reader (M3.5):
 * {@link admitRustLinuxElf} (x86_64, glibc's loader, glibc ≤ 2.28, only glibc and
 * {@link RUST_LINUX_LIBRARIES}, no GL of any kind, `DT_RUNPATH` absent or `$ORIGIN`, no `DT_RPATH`)
 * and {@link admitAndroidElf} (aarch64 bionic, a shared object or a `linker64` executable, only
 * {@link ANDROID_LIBRARIES}, every `PT_LOAD` aligned to 16 KB, no search path).
 */
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import { type FileHandle, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ANDROID_LOAD_ALIGN_BYTES,
  NativeRefusal,
  RustAdmissionProblem,
  type RustBinaryRefusal,
} from "../shared/native-contract.ts";
import {
  type BundleReads,
  openBundleFile,
  readBundleFile,
  WalkKind,
  WalkProblem,
  type WalkRefused,
  walkBundle,
} from "./bundle-walk.ts";
import { openNoFollow } from "./fsx.ts";
import { LinuxRuntimeFile } from "./native-runtime-files.ts";

/** The most of one ELF the gate reads: a game, or the host's 8.5 MB `libGLESv2.so`. */
export const LINUX_ELF_MAX_BYTES = 256 * 1024 * 1024;
const PROGRAM_HEADERS_MAX = 256;
const DYNAMIC_ENTRIES_MAX = 4096;
const STRING_BYTES_MAX = 4096;
const VERSION_FILES_MAX = 256;
const VERSION_NAMES_MAX = 4096;
const BUNDLE_NAME_BYTES_MAX = 1024;
const BUNDLE_SEGMENT_BYTES_MAX = 255;
const MAGIC_BYTES = 4;
/** x86_64's page: the unit the kernel and ld.so map loaded segments in. */
const PAGE_BYTES = 4096;
/** How every bundle file is opened: read-only, never blocking (a FIFO), never as a controlling terminal. */
const OPEN_FLAGS = FS.O_RDONLY | FS.O_NONBLOCK | FS.O_NOCTTY;

/** `e_machine` of an x86_64 ELF: the only Linux destination (D18 = x64 only). */
export const LINUX_X64_MACHINE = 62;
/** The glibc loader every x86_64 game starts through. */
export const LINUX_INTERPRETER = "/lib64/ld-linux-x86-64.so.2";
/** The game's one `DT_RUNPATH`: the host's ANGLE sits beside it at the bundle root. */
export const LINUX_GAME_RUNPATH = "$ORIGIN";
/** The newest glibc symbol version any ELF in a bundle may need (RHEL 8, Debian 10, Ubuntu 20.04). */
export const LINUX_GLIBC_FLOOR = "2.28";
/** The bundled ANGLE libraries a game imports by these exact names (their `DT_SONAME`). */
export const LINUX_ANGLE_IMPORTS: readonly string[] = [LinuxRuntimeFile.Gles, LinuxRuntimeFile.Egl];
/** The files the host writes beside the game from the store's Linux ANGLE (`recipe.json` outputs). */
export const LINUX_HOST_FILES: readonly LinuxRuntimeFile[] = Object.values(LinuxRuntimeFile);
/** glibc's own x86_64 libraries, which every player's system has: the only other imports allowed. */
export const GLIBC_SONAMES: readonly string[] = [
  "libc.so.6",
  "libm.so.6",
  "libdl.so.2",
  "libpthread.so.0",
  "librt.so.1",
  "ld-linux-x86-64.so.2",
];

/** The libraries besides glibc's a Rust game may link on Linux: the unwinder, ALSA (cpal) and udev (gilrs). */
export const RUST_LINUX_LIBRARIES: readonly string[] = ["libgcc_s.so.1", "libasound.so.2", "libudev.so.1"];
/** `e_machine` of an AArch64 ELF: the one Android ABI Genex builds (`arm64-v8a`). */
export const ANDROID_AARCH64_MACHINE = 183;
/** The bionic loader an Android executable starts through; a shared object (the app's `libmain.so`) names none. */
export const ANDROID_INTERPRETER = "/system/bin/linker64";
/**
 * The NDK system libraries a Rust game may link on Android: bionic's own, the native activity
 * glue, logging, Vulkan (wgpu) and AAudio (cpal). Every other library, a network one or a bundled
 * `.so` of its own, is refused.
 */
export const ANDROID_LIBRARIES: readonly string[] = [
  "libc.so",
  "libm.so",
  "libdl.so",
  "libandroid.so",
  "liblog.so",
  "libvulkan.so",
  "libaaudio.so",
];
/** Any GL a Rust game never links: system GL, GLX, glvnd, GLES (any version) and EGL, by base name. */
const RUST_GL = /^lib(GL|GLX|GLU|GLEW|OpenGL|GLES(v\d)?(_CM)?|EGL|GLdispatch)([._]|$)/;

/** System GL, GLX and glvnd libraries by base name; ANGLE's exact names are excluded before this test. */
const FOREIGN_GL = /^lib(GL|GLX|GLU|GLEW|OpenGL|GLESv1_CM|GLESv2|EGL|GLdispatch)([._]|$)/;
const SHARED_OBJECT_NAME = /\.so(\.\d+)*$/i;
const GLIBC_VERSION = /^GLIBC_(\d{1,4}(?:\.\d{1,4}){1,3})$/;
const GLIBC_PREFIX = "GLIBC_";
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** What a name decoded from bytes that are not UTF-8 carries: such a name cannot be opened as listed. */
const REPLACEMENT_CHARACTER = "\uFFFD";

const ELF = {
  Class64: 2,
  DataLsb: 1,
  VersionCurrent: 1,
  HeaderBytes: 64,
  ProgramHeaderBytes: 56,
  DynamicBytes: 16,
  VerneedBytes: 16,
  VernauxBytes: 16,
  TypeExec: 2,
  TypeDyn: 3,
} as const;
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const;
const PT = { Load: 1, Dynamic: 2, Interp: 3, Phdr: 6 } as const;
const DT = {
  Null: 0,
  Needed: 1,
  PltRelSz: 2,
  PltGot: 3,
  Hash: 4,
  StrTab: 5,
  SymTab: 6,
  Rela: 7,
  RelaSz: 8,
  RelaEnt: 9,
  StrSz: 10,
  SymEnt: 11,
  Init: 12,
  Fini: 13,
  SoName: 14,
  RPath: 15,
  Symbolic: 16,
  Rel: 17,
  RelSz: 18,
  RelEnt: 19,
  PltRel: 20,
  Debug: 21,
  TextRel: 22,
  JmpRel: 23,
  BindNow: 24,
  InitArray: 25,
  FiniArray: 26,
  InitArraySz: 27,
  FiniArraySz: 28,
  RunPath: 29,
  Flags: 30,
  PreinitArray: 32,
  PreinitArraySz: 33,
  SymTabShndx: 34,
  RelrSz: 35,
  Relr: 36,
  RelrEnt: 37,
  AndroidRelr: 0x6fffe000,
  AndroidRelrSz: 0x6fffe001,
  AndroidRelrEnt: 0x6fffe003,
  GnuHash: 0x6ffffef5,
  DepAudit: 0x6ffffefb,
  Audit: 0x6ffffefc,
  VerSym: 0x6ffffff0,
  RelaCount: 0x6ffffff9,
  RelCount: 0x6ffffffa,
  Flags1: 0x6ffffffb,
  VerDef: 0x6ffffffc,
  VerDefNum: 0x6ffffffd,
  VerNeed: 0x6ffffffe,
  VerNeedNum: 0x6fffffff,
  Auxiliary: 0x7ffffffd,
  Filter: 0x7fffffff,
} as const;

/** Dynamic tags besides `DT_NEEDED` that make glibc's loader load a library by name: filters and auditors. */
export const ElfLoadTag = {
  Filter: "DT_FILTER",
  Auxiliary: "DT_AUXILIARY",
  Audit: "DT_AUDIT",
  DepAudit: "DT_DEPAUDIT",
} as const;
export type ElfLoadTag = (typeof ElfLoadTag)[keyof typeof ElfLoadTag];

const LOAD_TAGS = new Map<number, ElfLoadTag>([
  [DT.Filter, ElfLoadTag.Filter],
  [DT.Auxiliary, ElfLoadTag.Auxiliary],
  [DT.Audit, ElfLoadTag.Audit],
  [DT.DepAudit, ElfLoadTag.DepAudit],
]);

/**
 * The dynamic tags lld or GNU ld write into an x86_64 executable; a game carrying any other tag
 * is refused, so a tag that loads or redirects something (now or in a later glibc) never passes
 * unread. `DT_RPATH` is listed here and refused by its own rule.
 */
const EXECUTABLE_TAGS: ReadonlySet<number> = new Set([
  DT.Needed,
  DT.PltRelSz,
  DT.PltGot,
  DT.Hash,
  DT.StrTab,
  DT.SymTab,
  DT.Rela,
  DT.RelaSz,
  DT.RelaEnt,
  DT.StrSz,
  DT.SymEnt,
  DT.Init,
  DT.Fini,
  DT.SoName,
  DT.RPath,
  DT.Symbolic,
  DT.Rel,
  DT.RelSz,
  DT.RelEnt,
  DT.PltRel,
  DT.Debug,
  DT.TextRel,
  DT.JmpRel,
  DT.BindNow,
  DT.InitArray,
  DT.FiniArray,
  DT.InitArraySz,
  DT.FiniArraySz,
  DT.RunPath,
  DT.Flags,
  DT.PreinitArray,
  DT.PreinitArraySz,
  DT.SymTabShndx,
  DT.RelrSz,
  DT.Relr,
  DT.RelrEnt,
  DT.GnuHash,
  DT.VerSym,
  DT.RelaCount,
  DT.RelCount,
  DT.Flags1,
  DT.VerDef,
  DT.VerDefNum,
  DT.VerNeed,
  DT.VerNeedNum,
]);

/**
 * The tags an Android game's linker writes besides those: NDK r30's lld at API 29 packs relative
 * relocations as `DT_ANDROID_RELR`, `DT_ANDROID_RELRSZ` and `DT_ANDROID_RELRENT` (bionic reads
 * them like `DT_RELR`), so only the Android policy admits them.
 */
const ANDROID_TAGS: ReadonlySet<number> = new Set([
  ...EXECUTABLE_TAGS,
  DT.AndroidRelr,
  DT.AndroidRelrSz,
  DT.AndroidRelrEnt,
]);

/** What kind of loadable ELF a file is: an executable (`ET_EXEC`, or a PIE) or a shared object. */
export const ElfFileType = { Executable: "executable", SharedObject: "shared-object" } as const;
export type ElfFileType = (typeof ElfFileType)[keyof typeof ElfFileType];

/** Why the reader or the gate refused a file: finer than the `NativeRefusal` each maps to. */
export const ElfGateReason = {
  NotElf: "not-elf",
  Not64Bit: "not-64-bit",
  NotLittleEndian: "not-little-endian",
  Truncated: "truncated",
  Malformed: "malformed",
  TooLarge: "too-large",
  NotExecutable: "not-executable",
  WrongMachine: "wrong-machine",
  WrongInterpreter: "wrong-interpreter",
  NotRegular: "not-regular",
  BadName: "bad-name",
  ExeMissing: "exe-missing",
  TooManyFiles: "too-many-files",
  Symlink: "symlink",
  HardLink: "hard-link",
  ImportsForeignGl: "imports-foreign-gl",
  LoadsLibraryByTag: "loads-library-by-tag",
  UnknownDynamicTag: "unknown-dynamic-tag",
  MissingAngleImport: "missing-angle-import",
  NeedsForeignLibrary: "needs-foreign-library",
  RunpathNotOrigin: "runpath-not-origin",
  HasRpath: "has-rpath",
  GlibcTooNew: "glibc-too-new",
  GlibcUnknownVersion: "glibc-unknown-version",
  GlibcUnversioned: "glibc-unversioned",
  ExtraSharedObject: "extra-shared-object",
  ExtraElf: "extra-elf",
  HostFileDiffers: "host-file-differs",
} as const;
export type ElfGateReason = (typeof ElfGateReason)[keyof typeof ElfGateReason];

const REFUSAL = {
  [ElfGateReason.NotElf]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.Not64Bit]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.NotLittleEndian]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.Truncated]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.Malformed]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.TooLarge]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.NotExecutable]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.WrongMachine]: NativeRefusal.WrongMachine,
  [ElfGateReason.WrongInterpreter]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.NotRegular]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.BadName]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.ExeMissing]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.TooManyFiles]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.Symlink]: NativeRefusal.Symlink,
  [ElfGateReason.HardLink]: NativeRefusal.HardLink,
  [ElfGateReason.ImportsForeignGl]: NativeRefusal.ImportsLibGl,
  [ElfGateReason.LoadsLibraryByTag]: NativeRefusal.ExtraSharedObject,
  [ElfGateReason.UnknownDynamicTag]: NativeRefusal.NotAnExecutable,
  [ElfGateReason.MissingAngleImport]: NativeRefusal.MissingAngleImport,
  [ElfGateReason.NeedsForeignLibrary]: NativeRefusal.ForeignImport,
  [ElfGateReason.RunpathNotOrigin]: NativeRefusal.RunpathNotOrigin,
  [ElfGateReason.HasRpath]: NativeRefusal.RunpathNotOrigin,
  [ElfGateReason.GlibcTooNew]: NativeRefusal.GlibcTooNew,
  [ElfGateReason.GlibcUnknownVersion]: NativeRefusal.GlibcTooNew,
  [ElfGateReason.GlibcUnversioned]: NativeRefusal.GlibcTooNew,
  [ElfGateReason.ExtraSharedObject]: NativeRefusal.ExtraSharedObject,
  [ElfGateReason.ExtraElf]: NativeRefusal.ExtraSharedObject,
  [ElfGateReason.HostFileDiffers]: NativeRefusal.ExtraSharedObject,
} as const satisfies Record<ElfGateReason, NativeRefusal>;

const MESSAGE = {
  NotElf: "not an ELF file",
  Not64Bit: "not a 64-bit ELF",
  NotLittleEndian: "not a little-endian ELF",
  BadIdentVersion: "unknown ELF identification version",
  Truncated: (at: number, length: number) => `ends before byte ${at} + ${length}`,
  Huge: (at: number) => `the value at byte ${at} is beyond 2^53`,
  ProgramHeaderSize: (size: number) => `program headers of ${size} bytes, not 56`,
  ProgramHeaderCount: (count: number) => `${count} program headers (1–${PROGRAM_HEADERS_MAX} read)`,
  NoLoad: "no loaded segment",
  MemoryBelowFile: "a loaded segment is smaller in memory than in the file",
  LoadsOverlap: "loaded segments overlap or are out of order",
  LoadMisaligned: (vaddr: number, offset: number) =>
    `the load at 0x${vaddr.toString(16)} from offset 0x${offset.toString(16)} is not aligned to a page or its p_align`,
  LoadsSharePage: (vaddr: number) =>
    `the load at 0x${vaddr.toString(16)} shares a page with the one before it but maps it from other file bytes`,
  ProgramHeadersUnloaded: "the program headers are not in a loaded segment's file bytes",
  ProgramHeaderSegment: "PT_PHDR is not where the program headers load",
  Unmapped: (address: number) => `address 0x${address.toString(16)} is not in a loaded segment's file bytes`,
  TwoOf: (what: string) => `more than one ${what}`,
  InterpreterUnterminated: "the interpreter is not a NUL-terminated string",
  NotLoadable: (type: number) => `ELF type ${type} is neither an executable nor a shared object`,
  DynamicMismatch: "the dynamic segment's file offset is not where its address maps",
  DynamicUnterminated: `no DT_NULL in the dynamic segment's first ${DYNAMIC_ENTRIES_MAX} entries`,
  StringTableHalf: "DT_STRTAB and DT_STRSZ come only together",
  NoStringTable: "names without a string table",
  StringOutside: (index: number) => `string ${index} is outside the string table`,
  StringUnterminated: (index: number) => `string ${index} has no NUL within ${STRING_BYTES_MAX} bytes of the table`,
  VerneedCountAlone: "DT_VERNEEDNUM without DT_VERNEED",
  VerneedVersion: (version: number) => `version need of version ${version}`,
  VerneedTooMany: `more than ${VERSION_FILES_MAX} version needs or ${VERSION_NAMES_MAX} version names`,
  VerneedCount: (declared: number, found: number) => `DT_VERNEEDNUM says ${declared}, the chain has ${found}`,
  VernauxCount: (declared: number, found: number) => `a version need counts ${declared} names and chains ${found}`,
  TooLarge: (size: number) => `${size} bytes is over the ${LINUX_ELF_MAX_BYTES}-byte cap`,
  NotRegular: (name: string) => `${name} is not a regular file`,
  HardLink: (name: string) => `${name} is a hard link`,
  BadName: (name: string) => `${JSON.stringify(name)} is not a plain relative path in the bundle`,
  ExeMissing: (name: string) => `the bundle has no ${name}`,
  ExeName: (name: string) =>
    `${JSON.stringify(name)} cannot be the game: it must be a file at the bundle root named like no host file and no shared object`,
  WrongMachine: (machine: number) => `machine ${machine}, not x86_64 (${LINUX_X64_MACHINE})`,
  NotExecutable: "a shared object, not an executable",
  WrongInterpreter: (interpreter: string | null) =>
    interpreter === null
      ? "statically linked (no interpreter)"
      : `starts through ${interpreter}, not ${LINUX_INTERPRETER}`,
  ForeignGl: (name: string) => `imports ${name}: the game must draw through the bundled ANGLE`,
  TagLoad: (load: ElfTagLoad) => `names ${load.name} in ${load.tag}, which the loader also loads`,
  UnknownTag: (tag: number) =>
    tag < 0 ? "a dynamic tag beyond 32 bits" : `dynamic tag 0x${tag.toString(16)}, which no linker writes into a game`,
  MissingAngle: `imports neither ${LINUX_ANGLE_IMPORTS.join(" nor ")}`,
  ForeignLibrary: (name: string) => `needs ${name}, which neither glibc nor the bundle provides`,
  HasRpath: (rpath: string[]) =>
    `has DT_RPATH ${JSON.stringify(rpath)}; only DT_RUNPATH ${LINUX_GAME_RUNPATH} is allowed`,
  Runpath: (runpath: string[]) => `DT_RUNPATH is ${JSON.stringify(runpath)}, not exactly ${LINUX_GAME_RUNPATH}`,
  GlibcTooNew: (name: string, floor: string) => `needs ${name}, newer than glibc ${floor}`,
  GlibcUnknown: (name: string) => `needs ${name}, which no numbered glibc release guarantees`,
  GlibcUnversioned: (name: string) =>
    `needs ${name} without any GLIBC_ version, so nothing bounds the glibc it binds to`,
  ExtraSharedObject: (name: string) => `${name} is a shared object the host does not ship`,
  ExtraElf: (name: string) => `${name} is an ELF file besides the game`,
  HostFileDiffers: (name: string) => `${name} differs from the host's pinned copy`,
  BadHostFile: (name: string) => `host file ${JSON.stringify(name)} must be a root name with a sha256 digest`,
  BadFloor: (floor: string) => `glibc floor ${JSON.stringify(floor)} is not a version like 2.28`,
  ManifestMissing: (name: string) => `the ANGLE manifest pins no sha256 for ${name}`,
  RustMachine: (machine: number, expected: number) => `machine ${machine}, not ${expected}`,
  RustGl: (name: string) => `imports ${name}: a Rust game draws through wgpu on Vulkan alone`,
  RustForeign: (name: string) => `needs ${name}, which is not a system library a Rust game may link here`,
  Alignment: (align: number) => `a loaded segment is aligned to ${align} bytes, not ${ANDROID_LOAD_ALIGN_BYTES}`,
} as const;

/** A file the reader or the gate refused, with the reason. */
export class ElfError extends Error {
  readonly reason: ElfGateReason;

  constructor(reason: ElfGateReason, message: string) {
    super(message);
    this.name = "ElfError";
    this.reason = reason;
  }
}

/** One `.gnu.version_r` entry: a library and the version names needed from it, in file order. */
export interface ElfVersionNeed {
  file: string;
  names: string[];
}

/** A library a {@link ElfLoadTag} tag names. */
export interface ElfTagLoad {
  tag: ElfLoadTag;
  name: string;
}

/** What an ELF64 little-endian file tells the dynamic loader. */
export interface ElfImage {
  fileType: ElfFileType;
  /** `e_machine`; x86_64 is {@link LINUX_X64_MACHINE}. */
  machine: number;
  /** `PT_INTERP`, or null for a static executable or a shared object. */
  interpreter: string | null;
  soname: string | null;
  /** `DT_NEEDED`, in file order. */
  needed: string[];
  /** Each `DT_RUNPATH` value as written (colon lists are not split). */
  runpath: string[];
  /** Each `DT_RPATH` value as written. */
  rpath: string[];
  versionNeeds: ElfVersionNeed[];
  /** Libraries named by `DT_FILTER`, `DT_AUXILIARY`, `DT_AUDIT` or `DT_DEPAUDIT`, in file order. */
  tagLoads: ElfTagLoad[];
  /** Each distinct dynamic tag before `DT_NULL`, in first-seen order; -1 stands for any tag beyond 32 bits. */
  dynamicTags: number[];
  /** Every `PT_LOAD`'s `p_align`, in file order. */
  loadAlignments: number[];
}

interface Bytes {
  buffer: Buffer;
  view: DataView;
}

interface Segment {
  type: number;
  offset: number;
  vaddr: number;
  filesz: number;
  memsz: number;
  align: number;
}

/** The dynamic array's values for the tags the gate reads by name. */
interface DynamicValues {
  needed: number[];
  soname: number[];
  rpath: number[];
  runpath: number[];
  strtab: number[];
  strsz: number[];
  verneed: number[];
  verneednum: number[];
}

/** The dynamic array as the gate reads it: named values, library-loading tags and every tag seen. */
interface Dynamic {
  values: DynamicValues;
  tagLoads: Array<{ tag: ElfLoadTag; value: number }>;
  tags: Set<number>;
}

const DYNAMIC_KEY = new Map<number, keyof DynamicValues>([
  [DT.Needed, "needed"],
  [DT.SoName, "soname"],
  [DT.RPath, "rpath"],
  [DT.RunPath, "runpath"],
  [DT.StrTab, "strtab"],
  [DT.StrSz, "strsz"],
  [DT.VerNeed, "verneed"],
  [DT.VerNeedNum, "verneednum"],
]);

interface StringTable {
  offset: number;
  size: number;
}

const malformed = (message: string): ElfError => new ElfError(ElfGateReason.Malformed, message);

function need(b: Bytes, at: number, length: number): void {
  const outside = at < 0 || length < 0 || at + length > b.buffer.length;
  if (outside) {
    throw new ElfError(ElfGateReason.Truncated, MESSAGE.Truncated(at, length));
  }
}

function u16(b: Bytes, at: number): number {
  need(b, at, 2);
  return b.view.getUint16(at, true);
}

function u32(b: Bytes, at: number): number {
  need(b, at, 4);
  return b.view.getUint32(at, true);
}

function u64(b: Bytes, at: number): number {
  need(b, at, 8);
  const value = b.view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed(MESSAGE.Huge(at));
  return Number(value);
}

/** A dynamic tag as a number, or -1 for one beyond 32 bits (none the gate reads). */
function tagAt(b: Bytes, at: number): number {
  need(b, at, 8);
  const tag = b.view.getBigUint64(at, true);
  return tag > 0xffffffffn ? -1 : Number(tag);
}

function only<T>(values: readonly T[], what: string): T | null {
  if (values.length > 1) throw malformed(MESSAGE.TwoOf(what));
  return values[0] ?? null;
}

const hasElfMagic = (head: Uint8Array): boolean => ELF_MAGIC.every((byte, index) => head[index] === byte);

function readHeader(b: Bytes): { type: number; machine: number; phoff: number; phentsize: number; phnum: number } {
  if (b.buffer.length < MAGIC_BYTES || !hasElfMagic(b.buffer)) throw new ElfError(ElfGateReason.NotElf, MESSAGE.NotElf);
  need(b, 0, ELF.HeaderBytes);
  if (b.buffer[4] !== ELF.Class64) throw new ElfError(ElfGateReason.Not64Bit, MESSAGE.Not64Bit);
  if (b.buffer[5] !== ELF.DataLsb) throw new ElfError(ElfGateReason.NotLittleEndian, MESSAGE.NotLittleEndian);
  if (b.buffer[6] !== ELF.VersionCurrent) throw malformed(MESSAGE.BadIdentVersion);
  return { type: u16(b, 16), machine: u16(b, 18), phoff: u64(b, 32), phentsize: u16(b, 54), phnum: u16(b, 56) };
}

function readSegments(b: Bytes, header: ReturnType<typeof readHeader>): Segment[] {
  if (header.phentsize !== ELF.ProgramHeaderBytes) throw malformed(MESSAGE.ProgramHeaderSize(header.phentsize));
  if (header.phnum === 0 || header.phnum > PROGRAM_HEADERS_MAX)
    throw malformed(MESSAGE.ProgramHeaderCount(header.phnum));
  need(b, header.phoff, header.phnum * ELF.ProgramHeaderBytes);
  const segments = Array.from({ length: header.phnum }, (_, index): Segment => {
    const at = header.phoff + index * ELF.ProgramHeaderBytes;
    return {
      type: u32(b, at),
      offset: u64(b, at + 8),
      vaddr: u64(b, at + 16),
      filesz: u64(b, at + 32),
      memsz: u64(b, at + 40),
      align: u64(b, at + 48),
    };
  });
  for (const segment of segments) {
    if (segment.type === PT.Load || segment.type === PT.Interp) need(b, segment.offset, segment.filesz);
  }
  return segments;
}

const isPowerOfTwo = (value: number): boolean => {
  const big = BigInt(value);
  return big > 0n && (big & (big - 1n)) === 0n;
};

/** The loader maps a load whole pages at a time: its address and offset agree within its `p_align`, a power of two of at least a page. */
function alignedLoad(load: Segment): boolean {
  const alignment = isPowerOfTwo(load.align) && load.align >= PAGE_BYTES;
  return alignment && load.vaddr % load.align === load.offset % load.align;
}

const pageStart = (address: number): number => address - (address % PAGE_BYTES);
const pageEnd = (address: number): number => Math.ceil(address / PAGE_BYTES) * PAGE_BYTES;

/**
 * Two loads may share a page only when both map it from the same file page and the first zeroes
 * no tail of it: otherwise the later mapping replaces bytes the reader took from the file.
 */
function sharesPageSafely(previous: Segment, load: Segment): boolean {
  if (pageEnd(previous.vaddr + previous.memsz) <= pageStart(load.vaddr)) return true;
  const sameFilePage = previous.vaddr - previous.offset === load.vaddr - load.offset;
  return sameFilePage && previous.memsz === previous.filesz;
}

/** The `PT_LOAD` segments, which must be in address order, page-aligned and must not overlap or remap a page (as the loader assumes). */
function loadSegments(segments: readonly Segment[]): Segment[] {
  const loads = segments.filter((segment) => segment.type === PT.Load);
  if (loads.length === 0) throw malformed(MESSAGE.NoLoad);
  loads.forEach((load, index) => {
    if (load.memsz < load.filesz) throw malformed(MESSAGE.MemoryBelowFile);
    if (!alignedLoad(load)) throw malformed(MESSAGE.LoadMisaligned(load.vaddr, load.offset));
    const previous = loads[index - 1];
    if (!previous) return;
    if (load.vaddr < previous.vaddr + previous.memsz) throw malformed(MESSAGE.LoadsOverlap);
    if (!sharesPageSafely(previous, load)) throw malformed(MESSAGE.LoadsSharePage(load.vaddr));
  });
  return loads;
}

/**
 * The loader reads the program headers from memory (`AT_PHDR`), not from `e_phoff`: they must lie
 * in a load's file bytes, and a `PT_PHDR` must name the address they load at.
 */
function checkProgramHeadersLoaded(
  header: ReturnType<typeof readHeader>,
  segments: readonly Segment[],
  loads: readonly Segment[],
): void {
  const end = header.phoff + header.phnum * ELF.ProgramHeaderBytes;
  const covering = loads.find((load) => load.offset <= header.phoff && end <= load.offset + load.filesz);
  if (!covering) throw malformed(MESSAGE.ProgramHeadersUnloaded);
  const phdr = only(
    segments.filter((segment) => segment.type === PT.Phdr),
    "PT_PHDR",
  );
  const loadedAt = covering.vaddr + (header.phoff - covering.offset);
  const misplaced = phdr !== null && (phdr.offset !== header.phoff || phdr.vaddr !== loadedAt);
  if (misplaced) throw malformed(MESSAGE.ProgramHeaderSegment);
}

/** Where `length` bytes at `address` come from in the file, as the loader maps them. */
function fileOffset(loads: readonly Segment[], address: number, length: number): number {
  const load = loads.find((segment) => address >= segment.vaddr && address + length <= segment.vaddr + segment.filesz);
  if (!load) throw malformed(MESSAGE.Unmapped(address));
  return load.offset + (address - load.vaddr);
}

/** `PT_INTERP` as the kernel reads it: the file bytes at `p_offset`, NUL-terminated. */
function readInterpreter(b: Bytes, segments: readonly Segment[]): string | null {
  const interp = only(
    segments.filter((segment) => segment.type === PT.Interp),
    "PT_INTERP",
  );
  if (!interp) return null;
  const bytes = b.buffer.subarray(interp.offset, interp.offset + interp.filesz);
  const terminated = bytes.length > 0 && bytes.length <= STRING_BYTES_MAX && bytes[bytes.length - 1] === 0;
  if (!terminated) throw malformed(MESSAGE.InterpreterUnterminated);
  return bytes.toString("latin1", 0, bytes.indexOf(0));
}

function fileTypeOf(type: number, interpreter: string | null): ElfFileType {
  if (type === ELF.TypeExec) return ElfFileType.Executable;
  if (type !== ELF.TypeDyn) throw new ElfError(ElfGateReason.NotExecutable, MESSAGE.NotLoadable(type));
  return interpreter === null ? ElfFileType.SharedObject : ElfFileType.Executable;
}

/** The dynamic array through its address, as the loader reads it; null for a static file. */
function readDynamic(b: Bytes, segments: readonly Segment[], loads: readonly Segment[]): Dynamic | null {
  const segment = only(
    segments.filter((candidate) => candidate.type === PT.Dynamic),
    "PT_DYNAMIC",
  );
  if (!segment) return null;
  const offset = fileOffset(loads, segment.vaddr, segment.filesz);
  if (offset !== segment.offset) throw malformed(MESSAGE.DynamicMismatch);
  const dynamic: Dynamic = {
    values: { needed: [], soname: [], rpath: [], runpath: [], strtab: [], strsz: [], verneed: [], verneednum: [] },
    tagLoads: [],
    tags: new Set(),
  };
  const count = Math.min(Math.floor(segment.filesz / ELF.DynamicBytes), DYNAMIC_ENTRIES_MAX);
  for (let index = 0; index < count; index++) {
    const at = offset + index * ELF.DynamicBytes;
    const tag = tagAt(b, at);
    if (tag === DT.Null) return dynamic;
    dynamic.tags.add(tag);
    const key = DYNAMIC_KEY.get(tag);
    if (key) dynamic.values[key].push(u64(b, at + 8));
    const load = LOAD_TAGS.get(tag);
    if (load) dynamic.tagLoads.push({ tag: load, value: u64(b, at + 8) });
  }
  throw malformed(MESSAGE.DynamicUnterminated);
}

function readStringTable(loads: readonly Segment[], dynamic: DynamicValues): StringTable | null {
  const address = only(dynamic.strtab, "DT_STRTAB");
  const size = only(dynamic.strsz, "DT_STRSZ");
  if (address === null && size === null) return null;
  if (address === null || size === null) throw malformed(MESSAGE.StringTableHalf);
  return { offset: fileOffset(loads, address, size), size };
}

function stringAt(b: Bytes, table: StringTable | null, index: number): string {
  if (!table) throw malformed(MESSAGE.NoStringTable);
  if (index >= table.size) throw malformed(MESSAGE.StringOutside(index));
  const start = table.offset + index;
  const window = b.buffer.subarray(start, start + Math.min(table.size - index, STRING_BYTES_MAX + 1));
  const end = window.indexOf(0);
  if (end < 0 || end > STRING_BYTES_MAX) throw malformed(MESSAGE.StringUnterminated(index));
  return window.toString("latin1", 0, end);
}

interface VersionReader {
  b: Bytes;
  loads: readonly Segment[];
  strings: StringTable | null;
}

/** One version need's `Vernaux` chain, which must hold exactly `count` names. */
function readVersionNames(reader: VersionReader, address: number, count: number): string[] {
  if (count === 0) throw malformed(MESSAGE.VernauxCount(0, 1));
  const names: string[] = [];
  let at = address;
  for (;;) {
    if (names.length >= count) throw malformed(MESSAGE.VernauxCount(count, names.length + 1));
    const offset = fileOffset(reader.loads, at, ELF.VernauxBytes);
    names.push(stringAt(reader.b, reader.strings, u32(reader.b, offset + 8)));
    const next = u32(reader.b, offset + 12);
    if (next === 0) break;
    at += next;
  }
  if (names.length !== count) throw malformed(MESSAGE.VernauxCount(count, names.length));
  return names;
}

/** `.gnu.version_r` by its `vn_next` chain, as the loader walks it; `DT_VERNEEDNUM` must agree. */
function readVersionNeeds(reader: VersionReader, dynamic: DynamicValues): ElfVersionNeed[] {
  const address = only(dynamic.verneed, "DT_VERNEED");
  const declared = only(dynamic.verneednum, "DT_VERNEEDNUM");
  if (address === null) {
    if (declared !== null) throw malformed(MESSAGE.VerneedCountAlone);
    return [];
  }
  const needs: ElfVersionNeed[] = [];
  let names = 0;
  let at = address;
  for (;;) {
    const offset = fileOffset(reader.loads, at, ELF.VerneedBytes);
    const version = u16(reader.b, offset);
    if (version !== 1) throw malformed(MESSAGE.VerneedVersion(version));
    const count = u16(reader.b, offset + 2);
    names += count;
    if (needs.length >= VERSION_FILES_MAX || names > VERSION_NAMES_MAX) throw malformed(MESSAGE.VerneedTooMany);
    const file = stringAt(reader.b, reader.strings, u32(reader.b, offset + 4));
    needs.push({ file, names: readVersionNames(reader, at + u32(reader.b, offset + 8), count) });
    const next = u32(reader.b, offset + 12);
    if (next === 0) break;
    at += next;
  }
  if (declared !== null && declared !== needs.length) throw malformed(MESSAGE.VerneedCount(declared, needs.length));
  return needs;
}

/**
 * What an ELF64 little-endian file tells the loader. Throws {@link ElfError} for anything else,
 * malformed, or past the reader's caps; never another error, never unbounded work.
 */
export function parseElf(bytes: Uint8Array): ElfImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const b: Bytes = { buffer, view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
  const header = readHeader(b);
  const segments = readSegments(b, header);
  const loads = loadSegments(segments);
  checkProgramHeadersLoaded(header, segments, loads);
  const interpreter = readInterpreter(b, segments);
  const fileType = fileTypeOf(header.type, interpreter);
  const image: ElfImage = {
    fileType,
    machine: header.machine,
    interpreter,
    soname: null,
    needed: [],
    runpath: [],
    rpath: [],
    versionNeeds: [],
    tagLoads: [],
    dynamicTags: [],
    loadAlignments: loads.map((load) => load.align),
  };
  const dynamic = readDynamic(b, segments, loads);
  if (!dynamic) return image;
  const { values } = dynamic;
  const strings = readStringTable(loads, values);
  const text = (index: number): string => stringAt(b, strings, index);
  const soname = only(values.soname, "DT_SONAME");
  return {
    ...image,
    soname: soname === null ? null : text(soname),
    needed: values.needed.map(text),
    runpath: values.runpath.map(text),
    rpath: values.rpath.map(text),
    versionNeeds: readVersionNeeds({ b, loads, strings }, values),
    tagLoads: dynamic.tagLoads.map((load) => ({ tag: load.tag, name: text(load.value) })),
    dynamicTags: [...dynamic.tags],
  };
}

/** A numbered glibc version (`2.28`) as its parts, or null for an unnumbered or odd one. */
function glibcParts(version: string): number[] | null {
  const match = GLIBC_VERSION.exec(`${GLIBC_PREFIX}${version}`);
  return match?.[1] ? match[1].split(".").map(Number) : null;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Every `GLIBC_*` version name `image` needs, from any library, once each. */
function glibcNames(image: ElfImage): string[] {
  const names = image.versionNeeds.flatMap((need) => need.names.filter((name) => name.startsWith(GLIBC_PREFIX)));
  return [...new Set(names)];
}

/** The highest numbered glibc version `image` needs (`2.17`), or null when it needs none. */
export function highestGlibc(image: ElfImage): string | null {
  let best: { text: string; parts: number[] } | null = null;
  for (const name of glibcNames(image)) {
    const text = name.slice(GLIBC_PREFIX.length);
    const parts = glibcParts(text);
    const isNewer = parts !== null && (best === null || compareVersions(parts, best.parts) > 0);
    if (isNewer) best = { text, parts };
  }
  return best?.text ?? null;
}

/** A gate problem with one file: the reason and what it was about. */
interface Problem {
  reason: ElfGateReason;
  detail: string;
}

function glibcProblem(image: ElfImage, floor: { text: string; parts: number[] }): Problem | null {
  for (const name of glibcNames(image)) {
    const parts = glibcParts(name.slice(GLIBC_PREFIX.length));
    if (!parts) return { reason: ElfGateReason.GlibcUnknownVersion, detail: MESSAGE.GlibcUnknown(name) };
    if (compareVersions(parts, floor.parts) > 0) {
      return { reason: ElfGateReason.GlibcTooNew, detail: MESSAGE.GlibcTooNew(name, floor.text) };
    }
  }
  return null;
}

/** A game that needs a glibc library but declares no `GLIBC_` version binds to whatever glibc has. */
function unversionedGlibc(image: ElfImage): Problem | null {
  const glibcImport = image.needed.find((name) => GLIBC_SONAMES.includes(name));
  const bounded = glibcImport === undefined || glibcNames(image).length > 0;
  return bounded ? null : { reason: ElfGateReason.GlibcUnversioned, detail: MESSAGE.GlibcUnversioned(glibcImport) };
}

const isAngleImport = (name: string): boolean => LINUX_ANGLE_IMPORTS.includes(name);
/** A system GL by its base name; a path to ANGLE's own name is no ANGLE import, but no system GL either. */
const isForeignGl = (name: string): boolean => {
  const base = path.posix.basename(name);
  return !isAngleImport(base) && FOREIGN_GL.test(base);
};
const isAllowedImport = (name: string): boolean => isAngleImport(name) || GLIBC_SONAMES.includes(name);

type ExecutableCheck = (image: ElfImage) => Problem | null;

/** The executable's rules, in the order a refusal names the first broken one. */
const EXECUTABLE_CHECKS: readonly ExecutableCheck[] = [
  (image) =>
    image.machine === LINUX_X64_MACHINE
      ? null
      : { reason: ElfGateReason.WrongMachine, detail: MESSAGE.WrongMachine(image.machine) },
  (image) =>
    image.fileType === ElfFileType.Executable
      ? null
      : { reason: ElfGateReason.NotExecutable, detail: MESSAGE.NotExecutable },
  (image) =>
    image.interpreter === LINUX_INTERPRETER
      ? null
      : { reason: ElfGateReason.WrongInterpreter, detail: MESSAGE.WrongInterpreter(image.interpreter) },
  (image) => {
    const foreign = [...image.needed, ...image.tagLoads.map((load) => load.name)].find(isForeignGl);
    return foreign === undefined
      ? null
      : { reason: ElfGateReason.ImportsForeignGl, detail: MESSAGE.ForeignGl(foreign) };
  },
  (image) => {
    const load = image.tagLoads[0];
    return load === undefined ? null : { reason: ElfGateReason.LoadsLibraryByTag, detail: MESSAGE.TagLoad(load) };
  },
  (image) => {
    const unknown = image.dynamicTags.find((tag) => !EXECUTABLE_TAGS.has(tag));
    return unknown === undefined
      ? null
      : { reason: ElfGateReason.UnknownDynamicTag, detail: MESSAGE.UnknownTag(unknown) };
  },
  (image) =>
    image.needed.some(isAngleImport)
      ? null
      : { reason: ElfGateReason.MissingAngleImport, detail: MESSAGE.MissingAngle },
  (image) => {
    const foreign = image.needed.find((name) => !isAllowedImport(name));
    return foreign === undefined
      ? null
      : { reason: ElfGateReason.NeedsForeignLibrary, detail: MESSAGE.ForeignLibrary(foreign) };
  },
  (image) =>
    image.rpath.length === 0 ? null : { reason: ElfGateReason.HasRpath, detail: MESSAGE.HasRpath(image.rpath) },
  (image) =>
    image.runpath.length === 1 && image.runpath[0] === LINUX_GAME_RUNPATH
      ? null
      : { reason: ElfGateReason.RunpathNotOrigin, detail: MESSAGE.Runpath(image.runpath) },
  unversionedGlibc,
];

/** A Rust executable an ELF policy admitted: its image and the highest numbered glibc version it needs (Linux). */
export type RustElfAdmission = { ok: true; image: ElfImage; maxGlibc: string | null } | RustBinaryRefusal;

type RustElfCheck = (image: ElfImage) => RustBinaryRefusal | null;

const rustRefused = (refusal: NativeRefusal, problem: RustAdmissionProblem, detail: string): RustBinaryRefusal => ({
  ok: false,
  refusal,
  problem,
  detail,
});

/** Refuses an image built for another machine than `machine`. */
const rustMachine =
  (machine: number): RustElfCheck =>
  (image) =>
    image.machine === machine
      ? null
      : rustRefused(
          NativeRefusal.WrongMachine,
          RustAdmissionProblem.WrongMachine,
          MESSAGE.RustMachine(image.machine, machine),
        );

/** Refuses an image that starts through another loader than one of `interpreters` (null: a shared object's none). */
const rustInterpreter =
  (interpreters: ReadonlyArray<string | null>): RustElfCheck =>
  (image) =>
    interpreters.includes(image.interpreter)
      ? null
      : rustRefused(
          NativeRefusal.NotAnExecutable,
          RustAdmissionProblem.WrongInterpreter,
          MESSAGE.WrongInterpreter(image.interpreter),
        );

/** Refuses any GL import, by `DT_NEEDED` or by a loading tag. */
const rustGl: RustElfCheck = (image) => {
  const names = [...image.needed, ...image.tagLoads.map((load) => load.name)];
  const gl = names.find((name) => RUST_GL.test(path.posix.basename(name)));
  return gl === undefined
    ? null
    : rustRefused(NativeRefusal.ImportsLibGl, RustAdmissionProblem.OpenGl, MESSAGE.RustGl(gl));
};

/** Refuses a library loaded through a filter or auditor tag, and any tag no linker writes into a game. */
const rustTags =
  (allowed: ReadonlySet<number>): RustElfCheck =>
  (image) => {
    const load = image.tagLoads[0];
    if (load !== undefined) {
      return rustRefused(NativeRefusal.ExtraSharedObject, RustAdmissionProblem.LoadsByTag, MESSAGE.TagLoad(load));
    }
    const unknown = image.dynamicTags.find((tag) => !allowed.has(tag));
    if (unknown === undefined) return null;
    return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.Unreadable, MESSAGE.UnknownTag(unknown));
  };

/** Refuses a `DT_NEEDED` outside `allowed`. */
const rustImports =
  (allowed: readonly string[]): RustElfCheck =>
  (image) => {
    const foreign = image.needed.find((name) => !allowed.includes(name));
    if (foreign === undefined) return null;
    return rustRefused(NativeRefusal.ForeignImport, RustAdmissionProblem.ForeignImport, MESSAGE.RustForeign(foreign));
  };

/** Refuses any `DT_RPATH`, and a `DT_RUNPATH` other than one of `runpaths` (each a whole list). */
const rustSearchPath =
  (runpaths: ReadonlyArray<readonly string[]>): RustElfCheck =>
  (image) => {
    if (image.rpath.length > 0) {
      return rustRefused(
        NativeRefusal.RunpathNotOrigin,
        RustAdmissionProblem.SearchPath,
        MESSAGE.HasRpath(image.rpath),
      );
    }
    const same = (allowed: readonly string[]) =>
      allowed.length === image.runpath.length && allowed.every((entry, index) => image.runpath[index] === entry);
    if (runpaths.some(same)) return null;
    return rustRefused(NativeRefusal.RunpathNotOrigin, RustAdmissionProblem.SearchPath, MESSAGE.Runpath(image.runpath));
  };

/** Refuses a shared object where an executable belongs. */
const rustExecutable: RustElfCheck = (image) =>
  image.fileType === ElfFileType.Executable
    ? null
    : rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.NotAnExecutable, MESSAGE.NotExecutable);

/** Refuses a glibc symbol version past the floor, an unnumbered one, or glibc with no version at all. */
const rustGlibc =
  (floor: { text: string; parts: number[] }): RustElfCheck =>
  (image) => {
    const problem = glibcProblem(image, floor) ?? unversionedGlibc(image);
    if (!problem) return null;
    return rustRefused(NativeRefusal.GlibcTooNew, RustAdmissionProblem.GlibcTooNew, problem.detail);
  };

/** Refuses a `PT_LOAD` not aligned to a multiple of {@link ANDROID_LOAD_ALIGN_BYTES} (Google Play's 16 KB pages). */
const androidAlignment: RustElfCheck = (image) => {
  const short = image.loadAlignments.find((align) => align % ANDROID_LOAD_ALIGN_BYTES !== 0);
  if (short === undefined) return null;
  return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.LoadAlignment, MESSAGE.Alignment(short));
};

/** The Linux policy's rules, in the order a refusal names the first broken one. */
function rustLinuxChecks(floor: { text: string; parts: number[] }, requireOrigin: boolean): RustElfCheck[] {
  const runpaths: ReadonlyArray<readonly string[]> = requireOrigin
    ? [[LINUX_GAME_RUNPATH]]
    : [[], [LINUX_GAME_RUNPATH]];
  return [
    rustMachine(LINUX_X64_MACHINE),
    rustExecutable,
    rustInterpreter([LINUX_INTERPRETER]),
    rustGl,
    rustTags(EXECUTABLE_TAGS),
    rustImports([...GLIBC_SONAMES, ...RUST_LINUX_LIBRARIES]),
    rustSearchPath(runpaths),
    rustGlibc(floor),
  ];
}

/** The Android policy's rules, in the order a refusal names the first broken one. */
const ANDROID_CHECKS: readonly RustElfCheck[] = [
  rustMachine(ANDROID_AARCH64_MACHINE),
  rustInterpreter([null, ANDROID_INTERPRETER]),
  rustGl,
  rustTags(ANDROID_TAGS),
  rustImports(ANDROID_LIBRARIES),
  rustSearchPath([[]]),
  androidAlignment,
];

/** `bytes` read as ELF and held to `checks`; never throws. */
function admitRustElf(bytes: Uint8Array, checks: readonly RustElfCheck[]): RustElfAdmission {
  let image: ElfImage;
  try {
    image = parseElf(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.Unreadable, detail);
  }
  for (const check of checks) {
    const refusal = check(image);
    if (refusal) return refusal;
  }
  return { ok: true, image, maxGlibc: highestGlibc(image) };
}

/**
 * Admits a Rust · wgpu game's Linux executable from its bytes (M3.5): x86_64, started through
 * glibc's loader, linking only glibc and {@link RUST_LINUX_LIBRARIES} (Vulkan and SwiftShader are
 * loaded at run time, never linked), no GL, `DT_RUNPATH` absent or `$ORIGIN`, no `DT_RPATH`, and no
 * glibc symbol version above `glibcFloor` (2.28). `requireOrigin` (an export, which ships the
 * Vulkan loader and SwiftShader beside the game for its run-time `dlopen` to find through
 * `$ORIGIN`, M4.2) refuses a missing `DT_RUNPATH` too. Pure; never throws.
 */
export function admitRustLinuxElf(
  bytes: Uint8Array,
  options: { glibcFloor?: string; requireOrigin?: boolean } = {},
): RustElfAdmission {
  const text = options.glibcFloor ?? LINUX_GLIBC_FLOOR;
  const parts = glibcParts(text);
  if (!parts) throw new TypeError(MESSAGE.BadFloor(text));
  return admitRustElf(bytes, rustLinuxChecks({ text, parts }, options.requireOrigin === true));
}

/**
 * Admits a Rust · wgpu game's Android binary from its bytes (M3.5): AArch64 bionic, a shared object
 * (packaged as `libmain.so`) or an executable started through {@link ANDROID_INTERPRETER}, linking
 * only {@link ANDROID_LIBRARIES}, no GL, no search path, no dynamic tag but a linker's own (NDK
 * r30's Android RELR tags included), and every `PT_LOAD` aligned to 16 KB. Pure; never throws.
 */
export function admitAndroidElf(bytes: Uint8Array): RustElfAdmission {
  return admitRustElf(bytes, ANDROID_CHECKS);
}

/** The bundle a Linux build's output is admitted as. */
export interface LinuxAdmissionRequest {
  /** The bundle folder (the lane's output); the gate lists it itself, never following a link. */
  root: string;
  /** The game's executable: a file name at the root. */
  exe: string;
  /** The host's files by root-level name → sha256 of the store's pinned copy ({@link linuxHostFiles}). */
  hostFiles: Readonly<Record<string, string>>;
  /** The newest glibc version an ELF may need; {@link LINUX_GLIBC_FLOOR} by default. */
  glibcFloor?: string;
  /** The walk's folder reads (Node's by default); a test injects a listing no disk of its host can hold. */
  reads?: BundleReads;
}

/** An admitted Linux bundle. */
export interface AdmittedLinuxBundle {
  exe: string;
  /** `<root>/<exe>`, as admitted. */
  exePath: string;
  /** The admitted executable's bytes: what assembly copies, and checks it copied. */
  exeSha256: string;
  image: ElfImage;
  /** The highest numbered glibc version the game needs. */
  maxGlibc: string | null;
  /** Every regular file the gate found and admitted, as sorted `/`-separated paths, the game included. */
  files: string[];
  /** Bundle files byte-identical to the host's, which assembly writes over from the store. */
  hostCopies: string[];
}

/** Admission's answer: the admitted bundle, or the typed refusal, its finer reason and the file it was about. */
export type LinuxAdmission =
  | { ok: true; bundle: AdmittedLinuxBundle }
  | { ok: false; refusal: NativeRefusal; reason: ElfGateReason; file: string; detail: string };

type Refused = Extract<LinuxAdmission, { ok: false }>;

const refused = (file: string, problem: Problem): Refused => ({
  ok: false,
  refusal: REFUSAL[problem.reason],
  reason: problem.reason,
  file,
  detail: `${file}: ${problem.detail}`,
});

function badName(name: string): boolean {
  const segments = name.split("/");
  const badSegment = (segment: string): boolean =>
    segment === "" || segment === "." || segment === ".." || Buffer.byteLength(segment) > BUNDLE_SEGMENT_BYTES_MAX;
  const badCharacters = ["\0", "\\", REPLACEMENT_CHARACTER].some((character) => name.includes(character));
  const tooLong = Buffer.byteLength(name) > BUNDLE_NAME_BYTES_MAX;
  return badCharacters || tooLong || segments.some(badSegment);
}

/** Refuses the first name the bundle may not carry (a backslash, a byte that is not UTF-8, too long); the walk refused case twins. */
function namesProblem(files: readonly string[]): Refused | null {
  const bad = files.find(badName);
  return bad === undefined ? null : refused(bad, { reason: ElfGateReason.BadName, detail: MESSAGE.BadName(bad) });
}

/** A host file's name in any case: what assembly writes beside the game from the store. */
function isHostName(name: string, hostFiles: Readonly<Record<string, string>>): boolean {
  const folded = name.toLowerCase();
  return [...LINUX_HOST_FILES, ...Object.keys(hostFiles)].some((host) => host.toLowerCase() === folded);
}

/**
 * The game must sit at the root, where `$ORIGIN` finds the host's files, under a name assembly
 * never writes and the shared-object rule never skips.
 */
function exeProblem(exe: string, hostFiles: Readonly<Record<string, string>>): Refused | null {
  const misplaced = badName(exe) || exe.includes("/");
  const misnamed = isHostName(exe, hostFiles) || SHARED_OBJECT_NAME.test(exe);
  if (misplaced || misnamed) return refused(exe, { reason: ElfGateReason.BadName, detail: MESSAGE.ExeName(exe) });
  return null;
}

function checkRequest(request: LinuxAdmissionRequest): { text: string; parts: number[] } {
  for (const [name, digest] of Object.entries(request.hostFiles)) {
    const badHostEntry = name.includes("/") || badName(name) || !SHA256_HEX.test(digest);
    if (badHostEntry) throw new TypeError(MESSAGE.BadHostFile(name));
  }
  const text = request.glibcFloor ?? LINUX_GLIBC_FLOOR;
  const parts = glibcParts(text);
  if (!parts) throw new TypeError(MESSAGE.BadFloor(text));
  return { text, parts };
}

/** The ELF reason for each way the shared walk or a file's second open stops. */
const WALK_REASON = {
  [WalkProblem.NotAFolder]: ElfGateReason.NotRegular,
  [WalkProblem.Unreadable]: ElfGateReason.NotRegular,
  [WalkProblem.TooManyEntries]: ElfGateReason.TooManyFiles,
  [WalkProblem.TooDeep]: ElfGateReason.TooManyFiles,
  [WalkProblem.Swapped]: ElfGateReason.Symlink,
  [WalkProblem.BadName]: ElfGateReason.BadName,
  [WalkProblem.Symlink]: ElfGateReason.Symlink,
  [WalkProblem.Special]: ElfGateReason.NotRegular,
  [WalkProblem.HardLink]: ElfGateReason.HardLink,
  [WalkProblem.CaseTwin]: ElfGateReason.BadName,
} as const satisfies Record<WalkProblem, ElfGateReason>;

const walkRefused = (stopped: WalkRefused): Refused =>
  refused(stopped.path, { reason: WALK_REASON[stopped.problem], detail: stopped.detail });

/**
 * Every regular file under `root` as a `/`-separated path, depth first in name order, or the
 * first entry the shared walk refuses: a link, a FIFO, socket or device, a case or Unicode twin,
 * too many entries or folders. Hard links are judged when each file is opened.
 */
async function listBundle(root: string, reads: BundleReads | undefined): Promise<string[] | Refused> {
  const walk = await walkBundle(root, { reads, refuse: { hardLinks: false } });
  if (!walk.ok) return walkRefused(walk);
  return walk.entries.filter((entry) => entry.kind === WalkKind.File).map((entry) => entry.path);
}

/** One bundle file opened for reading: never through a link, never blocking, regular and single-linked. */
interface Opened {
  handle: FileHandle;
  size: number;
}

/** Opens one listed file again through the shared no-follow open, refusing a second hard link. */
async function openEntry(root: { given: string; real: string }, name: string): Promise<Opened | Refused> {
  const opened = await openBundleFile(root.given, name, { realRoot: root.real });
  if (!opened.ok) return walkRefused(opened);
  if (opened.info.nlink <= 1) return { handle: opened.handle, size: opened.info.size };
  await opened.handle.close();
  return refused(name, { reason: ElfGateReason.HardLink, detail: MESSAGE.HardLink(name) });
}

async function readAt(handle: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** The whole file, at most {@link LINUX_ELF_MAX_BYTES} by its size when opened. */
async function readWhole(opened: Opened): Promise<Buffer> {
  if (opened.size > LINUX_ELF_MAX_BYTES) throw new ElfError(ElfGateReason.TooLarge, MESSAGE.TooLarge(opened.size));
  return readAt(opened.handle, opened.size);
}

/** Runs `use` over an opened entry and closes it; an {@link ElfError} becomes the entry's refusal. */
async function withEntry<T>(
  root: { given: string; real: string },
  name: string,
  use: (opened: Opened) => Promise<T | Refused>,
): Promise<T | Refused> {
  const opened = await openEntry(root, name);
  if ("ok" in opened) return opened;
  try {
    return await use(opened);
  } catch (error) {
    if (error instanceof ElfError) return refused(name, { reason: error.reason, detail: error.message });
    throw error;
  } finally {
    await opened.handle.close();
  }
}

interface AdmittedExe {
  image: ElfImage;
  sha256: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function admitExe(
  root: { given: string; real: string },
  name: string,
  floor: { text: string; parts: number[] },
): Promise<AdmittedExe | Refused> {
  return withEntry(root, name, async (opened) => {
    const bytes = await readWhole(opened);
    const image = parseElf(bytes);
    for (const check of EXECUTABLE_CHECKS) {
      const problem = check(image);
      if (problem) return refused(name, problem);
    }
    const glibc = glibcProblem(image, floor);
    return glibc ? refused(name, glibc) : { image, sha256: sha256(bytes) };
  });
}

const HOST_COPY = "host-copy";
const ASSET = "asset";

/** Admits a file beside the game: a byte-identical host file, or an asset that is no ELF and no shared object. */
function admitCompanion(
  root: { given: string; real: string },
  name: string,
  request: LinuxAdmissionRequest,
  floor: { text: string; parts: number[] },
): Promise<typeof HOST_COPY | typeof ASSET | Refused> {
  const digest = Object.hasOwn(request.hostFiles, name) ? request.hostFiles[name] : undefined;
  const hostNameInOtherCase = digest === undefined && isHostName(name, request.hostFiles);
  const sharedObject = digest === undefined && SHARED_OBJECT_NAME.test(name);
  if (sharedObject || hostNameInOtherCase) {
    return Promise.resolve(
      refused(name, { reason: ElfGateReason.ExtraSharedObject, detail: MESSAGE.ExtraSharedObject(name) }),
    );
  }
  return withEntry(root, name, async (opened) => {
    if (digest === undefined) {
      const head = await readAt(opened.handle, MAGIC_BYTES);
      if (head.length === MAGIC_BYTES && hasElfMagic(head)) {
        return refused(name, { reason: ElfGateReason.ExtraElf, detail: MESSAGE.ExtraElf(name) });
      }
      return ASSET;
    }
    const bytes = await readWhole(opened);
    if (sha256(bytes) !== digest) {
      return refused(name, { reason: ElfGateReason.HostFileDiffers, detail: MESSAGE.HostFileDiffers(name) });
    }
    const glibc = hasElfMagic(bytes) ? glibcProblem(parseElf(bytes), floor) : null;
    return glibc ? refused(name, glibc) : HOST_COPY;
  });
}

const isRefused = (value: unknown): value is Refused =>
  typeof value === "object" && value !== null && "ok" in value && value.ok === false;

/**
 * Admits a Linux build's bundle, or names the first rule it breaks: the game's name, then any
 * entry the shared walk of `root` refuses (a missing or linked `root` included), then the game,
 * then the other files in walk order. Reads and
 * never writes; a request naming a host file outside the root, a digest that is not sha256 hex,
 * or an unnumbered floor throws `TypeError`.
 */
export async function admitLinuxBundle(request: LinuxAdmissionRequest): Promise<LinuxAdmission> {
  const floor = checkRequest(request);
  const exeName = exeProblem(request.exe, request.hostFiles);
  if (exeName) return exeName;
  const files = await listBundle(request.root, request.reads);
  if (isRefused(files)) return files;
  const root = { given: request.root, real: await realpath(request.root) };
  const names = namesProblem(files);
  if (names) return names;
  if (!files.includes(request.exe)) {
    return refused(request.exe, { reason: ElfGateReason.ExeMissing, detail: MESSAGE.ExeMissing(request.exe) });
  }
  const exe = await admitExe(root, request.exe, floor);
  if (isRefused(exe)) return exe;
  const hostCopies: string[] = [];
  for (const name of files) {
    if (name === request.exe) continue;
    const companion = await admitCompanion(root, name, request, floor);
    if (isRefused(companion)) return companion;
    if (companion === HOST_COPY) hostCopies.push(name);
  }
  return {
    ok: true,
    bundle: {
      exe: request.exe,
      exePath: path.join(request.root, request.exe),
      exeSha256: exe.sha256,
      image: exe.image,
      maxGlibc: highestGlibc(exe.image),
      files,
      hostCopies,
    },
  };
}

/** The ELF at `file`, read without following a link and within the size cap; throws {@link ElfError}. */
export async function readElf(file: string): Promise<ElfImage> {
  const handle = await openNoFollow(file, OPEN_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ElfError(ElfGateReason.NotRegular, MESSAGE.NotRegular(file));
    return parseElf(await readWhole({ handle, size: info.size }));
  } finally {
    await handle.close();
  }
}

/**
 * What the game at `exe` in a Linux build's folder whose real path is `realRoot` tells the dynamic
 * loader, read as admission reads a file (no link at its name or above it, never blocking, no other
 * hard link, within {@link LINUX_ELF_MAX_BYTES}); null when it cannot be read or is no ELF64 file.
 * Admission's refusal says what is wrong with a build; this says what its game needs. Never throws
 * and never writes.
 */
export async function readLinuxExecutable(root: string, exe: string, realRoot: string): Promise<ElfImage | null> {
  const read = await readBundleFile(root, exe, { realRoot, maxBytes: LINUX_ELF_MAX_BYTES });
  if (!read.ok) return null;
  try {
    return parseElf(read.bytes);
  } catch {
    return null;
  }
}

/** The host lock for {@link LinuxAdmissionRequest.hostFiles}, from the store's Linux ANGLE `manifest.json`. */
export function linuxHostFiles(manifest: unknown): Record<string, string> {
  const files = isRecord(manifest) && isRecord(manifest.files) ? manifest.files : {};
  return Object.fromEntries(
    LINUX_HOST_FILES.map((name) => {
      const entry = files[name];
      const digest = isRecord(entry) ? entry.sha256 : null;
      if (typeof digest !== "string" || !SHA256_HEX.test(digest)) throw new TypeError(MESSAGE.ManifestMissing(name));
      return [name, digest];
    }),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
