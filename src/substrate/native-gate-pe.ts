/**
 * The host's gate for a Windows build of a C++ · raylib game (plan §3.9, §8.7, M4b). A build's
 * output is agent-made, so the host reads PE/COFF headers itself: no `llvm-readobj`, no Windows
 * machine, every read bounds-checked, and a malformed file a typed problem, never a throw.
 *
 * - The game is an x64 executable that imports ANGLE's `libGLESv2.dll` by its bare name (GLFW
 *   loads `libEGL.dll` itself, so that import is allowed, not required) and never `opengl32.dll`,
 *   directly or delay-loaded (`glu32.dll` counts: it imports `opengl32.dll`). Every other import is
 *   a bare name Windows itself provides (the counterpart of the ELF gate's glibc list): the loader
 *   opens a name with a path as that path, so `C:\…\libGLESv2.dll` is not the bundled ANGLE and a
 *   share path would reach the network.
 * - A non-x64 game is `wrong-machine`, and an import neither Windows nor the bundle provides is
 *   `foreign-import`.
 * - Besides it, the only PE files a bundle may hold are the host's own ANGLE DLLs at its top, and
 *   a build-supplied copy of one must be byte-identical to the lock's pin; the host writes its own
 *   copy over it anyway. Links and hard links are refused anywhere, and so is an asset name
 *   Windows cannot hold (`windows-names.ts`, the export archive's rule too).
 * - The folder is read through the shared bounded walk (`bundle-walk.ts`); each file is then
 *   opened again without following a link and must be the very node the walk saw.
 * - The reader is strict where a lenient one could disagree with the Windows loader about which
 *   bytes it reads: sections must be ascending, non-overlapping, inside 4 GiB and file-aligned,
 *   and a table or name must lie inside one section's file data.
 *
 * `native-cross-admission.ts` admits a Windows build's `out/` through it, and
 * `native-rundir-cross.ts` assembles the run directory from what it admitted.
 *
 * A Rust · wgpu game's executable is held to its own policy ({@link admitRustPe}, M3.5): an x64
 * PE32+ executable importing only bare names of {@link RUST_WINDOWS_DLLS} (Windows' own, with
 * D3D12, DXGI and `d3dcompiler_47.dll` for wgpu's FXC path, which wgpu loads by bare name: the
 * executable's folder is searched first, so no DLL may sit beside it) and the API sets (the UCRT); never
 * OpenGL or ANGLE, never `dxcompiler.dll` or `dxil.dll` (wgpu is built with FXC alone), never a
 * network library or the old `msvcrt.dll`.
 */
import { createHash } from "node:crypto";
import { type FileHandle, realpath } from "node:fs/promises";
import { errorMessage } from "../shared/errors.ts";
import { NativeRefusal, RustAdmissionProblem, type RustBinaryRefusal } from "../shared/native-contract.ts";
import {
  BUNDLE_WALK_LIMITS,
  type BundleReads,
  foldedName,
  openBundleFile,
  readBundleFile,
  WALK_REPORT_ONLY,
  type WalkEntry,
  WalkKind,
  WalkProblem,
  type WalkRefused,
  walkBundle,
} from "./bundle-walk.ts";
import { isJsonObject } from "./fsx.ts";
import { WindowsRuntimeFile } from "./native-runtime-files.ts";
import { isWindowsSafeName } from "./windows-names.ts";

/** Sections a PE image may have: the Windows loader's own limit. */
const PE_MAX_SECTIONS = 96;
/** Import or delay-import descriptors read before the table counts as hostile. */
const PE_MAX_DESCRIPTORS = 4096;
/** Exported names read before the table counts as hostile. */
const PE_MAX_EXPORT_NAMES = 1 << 16;
/** The longest DLL or export name read, terminator included. */
const PE_MAX_NAME_BYTES = 512;
/** Bytes read from a file that is neither the game nor an ANGLE DLL: enough for the `MZ` magic. */
const PE_HEAD_BYTES = 64;
/** Raw section data starts on this boundary in every image a linker writes (the minimum FileAlignment). */
const PE_RAW_ALIGNMENT = 0x200;
const FOUR_GIB = 2 ** 32;

/** What {@link admitWindowsOutput} reads at most: the shared walk's caps, and the bytes it reads whole. */
export const WINDOWS_BUNDLE_LIMITS: WindowsBundleLimits = {
  ...BUNDLE_WALK_LIMITS,
  exeBytes: 512 * 1024 ** 2,
  angleBytes: 64 * 1024 ** 2,
};

/** PE/COFF layout: offsets, sizes and magic numbers the reader needs, by their spec names. */
const Pe = {
  DosMagic: 0x5a4d,
  LfanewAt: 0x3c,
  Signature: 0x0000_4550,
  CoffBytes: 20,
  OptionalPe32: 0x10b,
  OptionalPe32Plus: 0x20b,
  SectionHeaderBytes: 40,
  ImportDescriptorBytes: 20,
  DelayDescriptorBytes: 32,
  ExportDirectoryBytes: 40,
  MaxDirectories: 16,
  ExportDirectory: 0,
  ImportDirectory: 1,
  DelayImportDirectory: 13,
  FileExecutableImage: 0x0002,
  FileDll: 0x2000,
  /** Delay descriptors whose attributes lack this bit hold VAs instead of RVAs. */
  DelayRvaBased: 0x1,
} as const;

/** The machines a PE header names, as `pe_imports.py` spells them. */
export const PeMachine = { X64: "x64", X86: "x86", Arm64: "arm64", Other: "other" } as const;
export type PeMachine = (typeof PeMachine)[keyof typeof PeMachine];

/** `IMAGE_FILE_MACHINE_*` codes the gate names; anything else is `Other`. */
const MACHINE_CODES: ReadonlyMap<number, PeMachine> = new Map([
  [0x8664, PeMachine.X64],
  [0x014c, PeMachine.X86],
  [0xaa64, PeMachine.Arm64],
]);

/** Why bytes are not a PE image the reader can vouch for. Wire values; never rename one. */
export const PeProblem = {
  NoDosHeader: "no-dos-header",
  NoPeSignature: "no-pe-signature",
  OutOfBounds: "out-of-bounds",
  BadOptionalHeader: "bad-optional-header",
  TooManySections: "too-many-sections",
  BadSectionTable: "bad-section-table",
  UnmappedRva: "unmapped-rva",
  UninitialisedRva: "uninitialised-rva",
  BadName: "bad-name",
  TooManyDescriptors: "too-many-descriptors",
  TooManyExports: "too-many-exports",
} as const;
export type PeProblem = (typeof PeProblem)[keyof typeof PeProblem];

/**
 * The typed detail under a refusal: why a bundle has no admissible game (under
 * `NativeRefusal.NotAnExecutable`; a non-x64 game is `WrongMachine` under `NativeRefusal.WrongMachine`),
 * the import that needs a DLL nobody supplies (`ForeignImport`, under `NativeRefusal.ForeignImport`),
 * or why pinned ANGLE bytes are not an x64 DLL (under `AngleDigest`).
 */
export const WindowsExeProblem = {
  ...PeProblem,
  Missing: "missing",
  Unreadable: "unreadable",
  TooLarge: "too-large",
  WrongMachine: "wrong-machine",
  NotAnExeImage: "not-an-exe-image",
  NotADll: "not-a-dll",
  ForeignImport: "foreign-import",
  TooManyEntries: "too-many-entries",
  BadPath: "bad-path",
} as const;
export type WindowsExeProblem = (typeof WindowsExeProblem)[keyof typeof WindowsExeProblem];

/** The DLLs the host supplies beside a Windows game, from the store's D3D11-only ANGLE (`WindowsRuntimeFile`). */
export const WindowsAngleDll = WindowsRuntimeFile;
export type WindowsAngleDll = WindowsRuntimeFile;

/** The lock's sha256 (lowercase hex) for each host ANGLE DLL. */
export type WindowsAnglePins = Readonly<Record<WindowsAngleDll, string>>;

/** What one path in a build's output is, as read without following links. */
export const BundleEntryKind = {
  File: "file",
  Directory: "directory",
  Symlink: "symlink",
  /** A file the host could not open or read: it cannot be vouched for. */
  Unreadable: "unreadable",
  /** A FIFO, socket or device: never copied into a bundle. */
  Other: "other",
} as const;
export type BundleEntryKind = (typeof BundleEntryKind)[keyof typeof BundleEntryKind];

/** The NativeRefusal codes the Windows gate answers with. */
export type WindowsRefusal =
  | typeof NativeRefusal.NotAnExecutable
  | typeof NativeRefusal.WrongMachine
  | typeof NativeRefusal.ForeignImport
  | typeof NativeRefusal.Symlink
  | typeof NativeRefusal.HardLink
  | typeof NativeRefusal.ExtraPe
  | typeof NativeRefusal.ImportsOpengl32
  | typeof NativeRefusal.MissingAngleImport
  | typeof NativeRefusal.AngleDigest;

/** What a PE image's headers say. */
export interface PeImage {
  machine: PeMachine;
  /** `IMAGE_FILE_MACHINE_*` as read. */
  machineCode: number;
  /** A PE32+ (64-bit) optional header. */
  pe32Plus: boolean;
  /** COFF characteristics as read. */
  characteristics: number;
  dll: boolean;
  /** `IMAGE_FILE_EXECUTABLE_IMAGE`: the linker finished the image. */
  executable: boolean;
  /** Import-directory DLL names, in file order, as spelled. */
  imports: string[];
  /** Delay-import DLL names, in file order, as spelled. */
  delayImports: string[];
  /** Exported names, in table order. */
  exports: string[];
}

/** The reader's answer: the image, or why the bytes are not one. */
export type PeRead = { ok: true; image: PeImage } | { ok: false; problem: PeProblem; detail: string };

/** One path in a build's output, as {@link admitWindowsBundle} judges it. */
export interface BundleEntry {
  /** `/`-separated, relative to the output folder. */
  path: string;
  kind: BundleEntryKind;
  /** Hard links to a file (`nlink`). */
  links: number;
  /** A file's bytes: whole for the game and top-level ANGLE names (within limits), else its first bytes. */
  bytes: Uint8Array;
  /** Whether `bytes` is the whole file. */
  whole: boolean;
}

/** What admission checks a bundle against. */
export interface WindowsBundleOptions {
  /** The game executable's file name at the top of the output folder, as the lane names it (`*.exe`). */
  exe: string;
  pins: WindowsAnglePins;
}

/** How much of an output folder {@link admitWindowsOutput} reads before refusing it. */
export interface WindowsBundleLimits {
  entries: number;
  /** Folder nesting below the output folder. */
  depth: number;
  exeBytes: number;
  angleBytes: number;
}

/** An admitted Windows build: what the host copies, and the executable bytes it checked. */
export interface AdmittedWindowsBundle {
  /** The game: its path, the very bytes admission read (copy these, not the file) and its headers. */
  exe: { path: string; bytes: Uint8Array; image: PeImage };
  /** Regular files under `assets/` (in any capitals, as Windows and APFS find it), as found on disk, sorted. */
  assets: string[];
  /** Host ANGLE DLLs the build shipped too, digest-checked; the host writes its own copies over them. */
  suppliedAngle: WindowsAngleDll[];
  /** Other regular files (import libraries, debug files): not PE, never copied. */
  ignored: string[];
}

/** A refusal: the code, its typed detail when it has one, the path it is about and a sentence for logs. */
export interface WindowsRefused {
  ok: false;
  refusal: WindowsRefusal;
  /** See {@link WindowsExeProblem}; null when the code says it all. */
  problem: WindowsExeProblem | null;
  /** The path relative to the output folder (`.` for the folder itself). */
  file: string;
  detail: string;
}

/** Admission's answer. */
export type WindowsAdmission = { ok: true; bundle: AdmittedWindowsBundle } | WindowsRefused;

const MESSAGE = {
  NoDosHeader: "no MZ header",
  NoPeSignature: "no PE signature",
  OutOfBounds: (size: number, at: number, length: number) =>
    `a read of ${size} bytes at ${at} is outside the ${length}-byte file`,
  OptionalMagic: (magic: number) => `unknown optional header magic 0x${magic.toString(16)}`,
  OptionalSize: "the optional header is too small for its data directories",
  TooManySections: (count: number) => `${count} sections; the loader takes at most ${PE_MAX_SECTIONS}`,
  SectionOrder: "sections overlap, run out of order or past 4 GiB",
  SectionAlignment: (pointer: number) => `section data at the unaligned offset ${pointer}`,
  Unmapped: (rva: number) => `RVA 0x${rva.toString(16)} is in no section's file data`,
  Uninitialised: (rva: number) => `RVA 0x${rva.toString(16)} is in uninitialised section data`,
  BadName: (rva: number) => `the name at RVA 0x${rva.toString(16)} is unterminated`,
  TooManyDescriptors: (table: string) => `more than ${PE_MAX_DESCRIPTORS} ${table} descriptors`,
  TooManyExports: (count: number) => `${count} export names`,
  Missing: (exe: string) => `the build has no ${exe}`,
  BadExeName: (exe: string) => `${JSON.stringify(exe)} is not a top-level .exe name`,
  BadPath: (file: string) => `${JSON.stringify(file)} is not a path inside the output folder`,
  Unreadable: (file: string, detail: string) => `${file} cannot be read: ${detail}`,
  OpenFailed: "the host could not open or read it",
  NotAFolder: "it is not a folder",
  TooLarge: (file: string) => `${file} is larger than the gate reads`,
  WrongMachine: (machine: string, pe32Plus: boolean) =>
    `the image is ${machine} ${pe32Plus ? "PE32+" : "PE32"}; Windows games and their DLLs are x64 PE32+`,
  NotAnExeImage: "a DLL or unfinished image, not an executable",
  NotADll: "an executable, not a DLL",
  OpenGl: (name: string) => `it imports ${name}; a game draws through the bundled ANGLE`,
  MissingGles: `it does not import ${WindowsAngleDll.Gles} by its bare name, so the bundled ANGLE is not what loads`,
  ForeignImport: (name: string) =>
    `it imports ${JSON.stringify(name)}, which is a path or a DLL neither Windows nor the bundle provides`,
  AssetName: (file: string) => `${JSON.stringify(file)} is a name Windows cannot hold`,
  AssetTwice: (file: string) => `${JSON.stringify(file)} is another asset's name on Windows, which ignores case`,
  Link: (file: string) => `${file} is a link`,
  HardLink: (file: string) => `${file} has another hard link`,
  ExtraPe: (file: string) => `${file} is a PE file the host does not supply`,
  AngleDigest: (file: string) => `${file} is not the pinned ANGLE build`,
  TooManyEntries: (limit: string) => `the output folder has more ${limit} than the gate reads`,
  RustGl: (name: string) => `it imports ${name}; a Rust game draws through wgpu on D3D12 alone`,
  RustDxc: (name: string) => `it imports ${name}; a Rust game compiles shaders with d3dcompiler_47.dll (FXC) only`,
  RustForeign: (name: string) =>
    `it imports ${JSON.stringify(name)}, which is a path or a DLL a Rust game on Windows may not link`,
} as const;

/** A malformed image, thrown inside the reader and caught at its boundary. */
class PeFault extends Error {
  readonly problem: PeProblem;

  constructor(problem: PeProblem, message: string) {
    super(message);
    this.name = "PeFault";
    this.problem = problem;
  }
}

/** One section header: where its RVAs live in the file. */
interface Section {
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawPointer: number;
}

/** A parsed header: the bytes, the directories and the sections every later read maps through. */
interface Headers {
  bytes: Uint8Array;
  view: DataView;
  machineCode: number;
  characteristics: number;
  pe32Plus: boolean;
  imageBase: bigint;
  directories: Array<{ rva: number; size: number }>;
  sections: Section[];
}

/** Throws unless `size` bytes at `at` lie inside the file. */
function need(bytes: Uint8Array, at: number, size: number): void {
  if (at < 0 || size < 0 || at + size > bytes.byteLength) {
    throw new PeFault(PeProblem.OutOfBounds, MESSAGE.OutOfBounds(size, at, bytes.byteLength));
  }
}

function u16(image: Pick<Headers, "bytes" | "view">, at: number): number {
  need(image.bytes, at, 2);
  return image.view.getUint16(at, true);
}

function u32(image: Pick<Headers, "bytes" | "view">, at: number): number {
  need(image.bytes, at, 4);
  return image.view.getUint32(at, true);
}

/** The optional header's magic, image base and data directories. */
function optionalHeader(
  image: Pick<Headers, "bytes" | "view">,
  optional: number,
  optionalSize: number,
): Pick<Headers, "pe32Plus" | "imageBase" | "directories"> {
  const magic = u16(image, optional);
  if (magic !== Pe.OptionalPe32Plus && magic !== Pe.OptionalPe32) {
    throw new PeFault(PeProblem.BadOptionalHeader, MESSAGE.OptionalMagic(magic));
  }
  const pe32Plus = magic === Pe.OptionalPe32Plus;
  need(image.bytes, optional, pe32Plus ? 112 : 96);
  const imageBase = pe32Plus
    ? image.view.getBigUint64(optional + 24, true)
    : BigInt(image.view.getUint32(optional + 28, true));
  const first = pe32Plus ? 112 : 96;
  const count = Math.min(u32(image, optional + first - 4), Pe.MaxDirectories);
  if (first + 8 * count > optionalSize) throw new PeFault(PeProblem.BadOptionalHeader, MESSAGE.OptionalSize);
  const directories = Array.from({ length: count }, (_, index) => ({
    rva: u32(image, optional + first + 8 * index),
    size: u32(image, optional + first + 8 * index + 4),
  }));
  return { pe32Plus, imageBase, directories };
}

/** The section table, refused unless ascending, non-overlapping, inside 4 GiB and file-aligned. */
function sectionTable(image: Pick<Headers, "bytes" | "view">, table: number, count: number): Section[] {
  need(image.bytes, table, count * Pe.SectionHeaderBytes);
  const sections: Section[] = [];
  let end = 0;
  for (let index = 0; index < count; index++) {
    const at = table + index * Pe.SectionHeaderBytes;
    const section = {
      virtualSize: u32(image, at + 8),
      virtualAddress: u32(image, at + 12),
      rawSize: u32(image, at + 16),
      rawPointer: u32(image, at + 20),
    };
    const span = Math.max(section.virtualSize, section.rawSize);
    const ordered = section.virtualAddress >= end && section.virtualAddress + span <= FOUR_GIB;
    if (!ordered) throw new PeFault(PeProblem.BadSectionTable, MESSAGE.SectionOrder);
    if (section.rawSize > 0 && section.rawPointer % PE_RAW_ALIGNMENT !== 0) {
      throw new PeFault(PeProblem.BadSectionTable, MESSAGE.SectionAlignment(section.rawPointer));
    }
    end = section.virtualAddress + span;
    sections.push(section);
  }
  return sections;
}

/** The DOS, COFF and optional headers and the section table. */
function headers(bytes: Uint8Array): Headers {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const image = { bytes, view };
  if (bytes.byteLength < 2 || view.getUint16(0, true) !== Pe.DosMagic) {
    throw new PeFault(PeProblem.NoDosHeader, MESSAGE.NoDosHeader);
  }
  const pe = u32(image, Pe.LfanewAt);
  if (u32(image, pe) !== Pe.Signature) throw new PeFault(PeProblem.NoPeSignature, MESSAGE.NoPeSignature);
  need(bytes, pe + 4, Pe.CoffBytes);
  const sectionCount = u16(image, pe + 6);
  if (sectionCount > PE_MAX_SECTIONS) {
    throw new PeFault(PeProblem.TooManySections, MESSAGE.TooManySections(sectionCount));
  }
  const optionalSize = u16(image, pe + 20);
  const optional = pe + 4 + Pe.CoffBytes;
  return {
    ...image,
    machineCode: u16(image, pe + 4),
    characteristics: u16(image, pe + 22),
    ...optionalHeader(image, optional, optionalSize),
    sections: sectionTable(image, optional + optionalSize, sectionCount),
  };
}

/** The file offset of `size` bytes at `rva` and how far that section's file data reaches past it. */
function mapped(image: Headers, rva: number, size: number): { at: number; room: number } {
  const section = image.sections.find(
    (each) => rva >= each.virtualAddress && rva < each.virtualAddress + Math.max(each.virtualSize, each.rawSize),
  );
  if (!section) throw new PeFault(PeProblem.UnmappedRva, MESSAGE.Unmapped(rva));
  const into = rva - section.virtualAddress;
  if (into + size > section.rawSize) throw new PeFault(PeProblem.UninitialisedRva, MESSAGE.Uninitialised(rva));
  const at = section.rawPointer + into;
  need(image.bytes, at, size);
  return { at, room: section.rawSize - into };
}

/** The NUL-terminated ASCII name at `rva`, inside one section; a non-ASCII byte reads as U+FFFD, as Python's does. */
function nameAt(image: Headers, rva: number): string {
  const { at, room } = mapped(image, rva, 1);
  const limit = Math.min(room, PE_MAX_NAME_BYTES, image.bytes.byteLength - at);
  const end = image.bytes.subarray(at, at + limit).indexOf(0);
  if (end < 0) throw new PeFault(PeProblem.BadName, MESSAGE.BadName(rva));
  let name = "";
  for (const byte of image.bytes.subarray(at, at + end)) name += byte < 0x80 ? String.fromCharCode(byte) : "�";
  return name;
}

function directory(image: Headers, index: number): number {
  return image.directories[index]?.rva ?? 0;
}

/** Import-directory DLL names, up to the all-zero descriptor. */
function importNames(image: Headers): string[] {
  const table = directory(image, Pe.ImportDirectory);
  const names: string[] = [];
  if (table === 0) return names;
  for (let index = 0; index < PE_MAX_DESCRIPTORS; index++) {
    const { at } = mapped(image, table + index * Pe.ImportDescriptorBytes, Pe.ImportDescriptorBytes);
    const descriptor = image.bytes.subarray(at, at + Pe.ImportDescriptorBytes);
    if (descriptor.every((byte) => byte === 0)) return names;
    names.push(nameAt(image, u32(image, at + 12)));
  }
  throw new PeFault(PeProblem.TooManyDescriptors, MESSAGE.TooManyDescriptors("import"));
}

/** A delay descriptor's name as an RVA: old-form descriptors hold a VA, made relative to the image base. */
function delayNameRva(image: Headers, attributes: number, name: number): number {
  if (attributes & Pe.DelayRvaBased) return name;
  const rva = BigInt(name) - image.imageBase;
  if (rva < 0n || rva >= BigInt(FOUR_GIB)) throw new PeFault(PeProblem.UnmappedRva, MESSAGE.Unmapped(name));
  return Number(rva);
}

/** Delay-import DLL names, up to the descriptor with no name. */
function delayImportNames(image: Headers): string[] {
  const table = directory(image, Pe.DelayImportDirectory);
  const names: string[] = [];
  if (table === 0) return names;
  for (let index = 0; index < PE_MAX_DESCRIPTORS; index++) {
    const { at } = mapped(image, table + index * Pe.DelayDescriptorBytes, Pe.DelayDescriptorBytes);
    const name = u32(image, at + 4);
    if (name === 0) return names;
    names.push(nameAt(image, delayNameRva(image, u32(image, at), name)));
  }
  throw new PeFault(PeProblem.TooManyDescriptors, MESSAGE.TooManyDescriptors("delay-import"));
}

/** Exported names, in the name table's order. */
function exportNames(image: Headers): string[] {
  const table = directory(image, Pe.ExportDirectory);
  if (table === 0) return [];
  const { at } = mapped(image, table, Pe.ExportDirectoryBytes);
  const count = u32(image, at + 24);
  if (count > PE_MAX_EXPORT_NAMES) throw new PeFault(PeProblem.TooManyExports, MESSAGE.TooManyExports(count));
  if (count === 0) return [];
  const names = mapped(image, u32(image, at + 32), 4 * count).at;
  return Array.from({ length: count }, (_, index) => nameAt(image, u32(image, names + 4 * index)));
}

/** What the PE headers in `bytes` say, or why they are not a PE image this reader vouches for. Never throws. */
export function readPe(bytes: Uint8Array): PeRead {
  try {
    const image = headers(bytes);
    return {
      ok: true,
      image: {
        machine: MACHINE_CODES.get(image.machineCode) ?? PeMachine.Other,
        machineCode: image.machineCode,
        pe32Plus: image.pe32Plus,
        characteristics: image.characteristics,
        dll: (image.characteristics & Pe.FileDll) !== 0,
        executable: (image.characteristics & Pe.FileExecutableImage) !== 0,
        imports: importNames(image),
        delayImports: delayImportNames(image),
        exports: exportNames(image),
      },
    };
  } catch (error) {
    if (error instanceof PeFault) return { ok: false, problem: error.problem, detail: error.message };
    return { ok: false, problem: PeProblem.OutOfBounds, detail: errorMessage(error) };
  }
}

/** File extensions Windows loads code from; a bundle carries none but the game and the host DLLs. */
const PE_EXTENSIONS: ReadonlySet<string> = new Set([".dll", ".exe", ".sys", ".drv", ".ocx", ".cpl", ".scr", ".efi"]);
/** DLLs that put desktop OpenGL in the process: `glu32.dll` imports `opengl32.dll`. */
const OPENGL_DLLS: ReadonlySet<string> = new Set(["opengl32.dll", "glu32.dll"]);
const ANGLE_BY_KEY: ReadonlyMap<string, WindowsAngleDll> = new Map(
  Object.values(WindowsAngleDll).map((name) => [name.toLowerCase(), name]),
);
const GLES_KEY = WindowsAngleDll.Gles.toLowerCase();
/**
 * DLLs in `System32` on every Windows 10 22H2 / 11 x64 install that a C/C++ game may import: the
 * only imports allowed besides the bundled ANGLE and the API sets. Lowercase, as {@link bareDllKey}
 * spells them. Anything else is resolved through the player's PATH, so it is refused.
 */
const WINDOWS_SYSTEM_DLLS: ReadonlySet<string> = new Set(
  [
    "advapi32",
    "avrt",
    "bcrypt",
    "bcryptprimitives",
    "cfgmgr32",
    "comctl32",
    "comdlg32",
    "crypt32",
    "d2d1",
    "d3d11",
    "d3d12",
    "d3d9",
    "dbghelp",
    "dinput8",
    "dnsapi",
    "dsound",
    "dwmapi",
    "dwrite",
    "dxgi",
    "gdi32",
    "gdiplus",
    "hid",
    "imm32",
    "iphlpapi",
    "kernel32",
    "kernelbase",
    "mfplat",
    "mfreadwrite",
    "msvcrt",
    "mswsock",
    "ncrypt",
    "normaliz",
    "ntdll",
    "ole32",
    "oleaut32",
    "powrprof",
    "propsys",
    "psapi",
    "rpcrt4",
    "secur32",
    "setupapi",
    "shcore",
    "shell32",
    "shlwapi",
    "ucrtbase",
    "user32",
    "userenv",
    "uxtheme",
    "version",
    "windowscodecs",
    "winhttp",
    "wininet",
    "winmm",
    "ws2_32",
    "wsock32",
    "wtsapi32",
    "xaudio2_9",
    "xinput1_4",
    "xinput9_1_0",
  ].map((name) => `${name}.dll`),
);
/**
 * The System32 DLLs a Rust · wgpu game may import (bare names, lowercase): what the M2 Windows build
 * of winit, wgpu (D3D12 through FXC), cpal, gilrs and std imports
 * (`tests/fixtures/rust-bundles/m2-binaries.json`), plus D3D12 and the shader compiler wgpu loads
 * and the few their other paths may link, and COM's `combase.dll` (gilrs reads gamepads through
 * Windows.Gaming.Input, which the template's M4.1 build imports) and `mmdevapi.dll` (cpal's WASAPI
 * output activates its audio client with `ActivateAudioInterfaceAsync`, AU-5). No network, no
 * desktop OpenGL, no other CRT than the UCRT (through the API sets). A new DLL is a reviewed change to this list,
 * never a pass.
 */
export const RUST_WINDOWS_DLLS: ReadonlySet<string> = new Set(
  [
    "advapi32",
    "avrt",
    "bcrypt",
    "bcryptprimitives",
    "cfgmgr32",
    "combase",
    "comctl32",
    "d3d12",
    "d3dcompiler_47",
    "dwmapi",
    "dxgi",
    "gdi32",
    "hid",
    "imm32",
    "kernel32",
    "kernelbase",
    "mmdevapi",
    "ntdll",
    "ole32",
    "oleaut32",
    "propsys",
    "setupapi",
    "shcore",
    "shell32",
    "shlwapi",
    "user32",
    "userenv",
    "uxtheme",
    "version",
    "winmm",
    "xinput1_4",
  ].map((name) => `${name}.dll`),
);
/**
 * What a `[net]` game's export may import besides {@link RUST_WINDOWS_DLLS}: the sockets and the
 * certificate store its relay client (libcolyseus, MP-1a) links. Admitted only for such a build
 * (`admitRustPe`'s `network`); every other Rust game still opens no network.
 */
export const RUST_WINDOWS_NET_DLLS: ReadonlySet<string> = new Set(["ws2_32", "crypt32"].map((name) => `${name}.dll`));
/** ANGLE's GL libraries (not its `d3dcompiler_47.dll`, which is System32's too): a raylib game's, never a Rust one's. */
const ANGLE_GL_KEYS: ReadonlySet<string> = new Set(
  [WindowsAngleDll.Egl, WindowsAngleDll.Gles].map((name) => name.toLowerCase()),
);
/** DirectX shader compilers wgpu's DXC path would load: refused, the export is built for FXC (`d3dcompiler_47.dll`). */
const DXC_DLLS: ReadonlySet<string> = new Set(["dxcompiler.dll", "dxil.dll"]);
/** An API set the loader maps to a system DLL (`api-ms-win-crt-*` is the UCRT zig and llvm-mingw link). */
const API_SET_DLL = /^api-ms-win-[a-z0-9-]+\.dll$/;
const ASSETS_FOLDER = "assets";
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A file or DLL name as Windows resolves it: the last path component, cut at an NTFS stream
 * colon, trailing dots and spaces dropped (Win32 drops them), lowercased.
 */
function windowsKey(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const stream = base.indexOf(":");
  return (stream < 0 ? base : base.slice(0, stream)).replace(/[. ]+$/, "").toLowerCase();
}

/** The loader appends `.dll` to a module name with no extension. */
const withDllExtension = (key: string): string => (key.includes(".") ? key : `${key}.dll`);

/**
 * An imported DLL's base-name key, liberal on purpose: for the OpenGL deny check, where a path,
 * a stream suffix or trailing dots must not hide `opengl32.dll`.
 */
function dllKey(name: string): string {
  return withDllExtension(windowsKey(name));
}

/**
 * The key of an import the loader looks up by name in the app's folder and the system: a bare
 * name Windows can hold, lowercased, `.dll` supplied. Null for anything with a path, drive,
 * stream or trailing dot or space, which the loader opens as a path or does not find by name.
 */
function bareDllKey(name: string): string | null {
  return isWindowsSafeName(name) ? withDllExtension(name.toLowerCase()) : null;
}

/** Whether a bare import key names the bundled ANGLE or a DLL every supported Windows has. */
function isProvidedDll(key: string | null): boolean {
  if (key === null) return false;
  return ANGLE_BY_KEY.has(key) || WINDOWS_SYSTEM_DLLS.has(key) || API_SET_DLL.test(key);
}

function hasPeExtension(name: string): boolean {
  const key = windowsKey(name);
  const dot = key.lastIndexOf(".");
  return dot >= 0 && PE_EXTENSIONS.has(key.slice(dot));
}

/** The host ANGLE DLL a top-level name stands for (in any capitals), or undefined. */
function topLevelAngle(relative: string): WindowsAngleDll | undefined {
  return relative.includes("/") ? undefined : ANGLE_BY_KEY.get(windowsKey(relative));
}

/** Whether `bytes` start with the DOS magic every PE image starts with. */
function looksLikePe(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function refused(
  refusal: WindowsRefusal,
  file: string,
  detail: string,
  problem: WindowsExeProblem | null = null,
): WindowsRefused {
  return { ok: false, refusal, problem, file, detail };
}

function notExecutable(file: string, problem: WindowsExeProblem, detail: string): WindowsRefused {
  return refused(NativeRefusal.NotAnExecutable, file, detail, problem);
}

/** Whether `exe` names a top-level `.exe` file and nothing else. */
function isExeName(exe: string): boolean {
  const plain = exe !== "" && !/[/\\:]/.test(exe) && exe !== "." && exe !== "..";
  return plain && windowsKey(exe) === exe.toLowerCase() && exe.toLowerCase().endsWith(".exe");
}

/** Whether `relative` is a `/`-separated path inside the output folder. */
function isInside(relative: string): boolean {
  if (relative === "" || relative.startsWith("/")) return false;
  return relative.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** An x64 machine with a PE32+ optional header: what every Windows game and host DLL is. */
const isX64Image = (image: PeImage): boolean => image.machine === PeMachine.X64 && image.pe32Plus;

/** Whether `relative` lies under the top-level assets folder, in whatever capitals or Win32 spelling it has. */
function isUnderAssets(relative: string): boolean {
  const slash = relative.indexOf("/");
  return slash > 0 && windowsKey(relative.slice(0, slash)) === ASSETS_FOLDER;
}

/**
 * The refusal an x64 game image earns from its imports and delay imports, or null: desktop
 * OpenGL under any spelling first, then no bare `libGLESv2.dll`, then any import that is a path
 * or a DLL neither Windows nor the bundle provides.
 */
function importRefusal(image: PeImage, file: string): WindowsRefused | null {
  const imported = [...image.imports, ...image.delayImports];
  const openGl = imported.find((name) => OPENGL_DLLS.has(dllKey(name)));
  if (openGl !== undefined) return refused(NativeRefusal.ImportsOpengl32, file, MESSAGE.OpenGl(openGl));
  if (!imported.some((name) => bareDllKey(name) === GLES_KEY)) {
    return refused(NativeRefusal.MissingAngleImport, file, MESSAGE.MissingGles);
  }
  const foreign = imported.find((name) => !isProvidedDll(bareDllKey(name)));
  if (foreign === undefined) return null;
  return refused(NativeRefusal.ForeignImport, file, MESSAGE.ForeignImport(foreign), WindowsExeProblem.ForeignImport);
}

/** The game's headers, or why the entry is not an x64 Windows executable that draws through ANGLE. */
function gameImage(entry: BundleEntry | undefined, exe: string): { image: PeImage } | WindowsRefused {
  if (!entry || entry.kind === BundleEntryKind.Directory || entry.kind === BundleEntryKind.Other) {
    return notExecutable(exe, WindowsExeProblem.Missing, MESSAGE.Missing(exe));
  }
  if (entry.kind === BundleEntryKind.Unreadable) {
    return notExecutable(exe, WindowsExeProblem.Unreadable, MESSAGE.Unreadable(exe, MESSAGE.OpenFailed));
  }
  if (!entry.whole) return notExecutable(exe, WindowsExeProblem.TooLarge, MESSAGE.TooLarge(exe));
  const read = readPe(entry.bytes);
  if (!read.ok) return notExecutable(exe, read.problem, read.detail);
  const { image } = read;
  if (!isX64Image(image)) {
    const detail = MESSAGE.WrongMachine(image.machine, image.pe32Plus);
    return refused(NativeRefusal.WrongMachine, exe, detail, WindowsExeProblem.WrongMachine);
  }
  if (image.dll || !image.executable) {
    return notExecutable(exe, WindowsExeProblem.NotAnExeImage, MESSAGE.NotAnExeImage);
  }
  return importRefusal(image, exe) ?? { image };
}

/** The refusal one entry earns from where it is and what it is, or null; the game itself is judged apart. */
function entryRefusal(entry: BundleEntry, pins: WindowsAnglePins): WindowsRefused | null {
  if (!isInside(entry.path)) {
    return notExecutable(entry.path, WindowsExeProblem.BadPath, MESSAGE.BadPath(entry.path));
  }
  if (entry.kind === BundleEntryKind.Symlink) {
    return refused(NativeRefusal.Symlink, entry.path, MESSAGE.Link(entry.path));
  }
  if (entry.kind === BundleEntryKind.Unreadable) {
    return notExecutable(entry.path, WindowsExeProblem.Unreadable, MESSAGE.Unreadable(entry.path, MESSAGE.OpenFailed));
  }
  const content = entry.kind === BundleEntryKind.File ? fileRefusal(entry, pins) : null;
  if (content !== null || !isUnderAssets(entry.path)) return content;
  const holdable = entry.path.split("/").every(isWindowsSafeName);
  return holdable ? null : notExecutable(entry.path, WindowsExeProblem.BadPath, MESSAGE.AssetName(entry.path));
}

/** The refusal a regular file earns from its links, its name and its bytes, or null. */
function fileRefusal(entry: BundleEntry, pins: WindowsAnglePins): WindowsRefused | null {
  if (entry.links > 1) return refused(NativeRefusal.HardLink, entry.path, MESSAGE.HardLink(entry.path));
  const angle = topLevelAngle(entry.path);
  if (angle !== undefined) {
    const same = entry.whole && sha256(entry.bytes) === pins[angle];
    return same ? null : refused(NativeRefusal.AngleDigest, entry.path, MESSAGE.AngleDigest(entry.path));
  }
  if (hasPeExtension(entry.path) || looksLikePe(entry.bytes)) {
    return refused(NativeRefusal.ExtraPe, entry.path, MESSAGE.ExtraPe(entry.path));
  }
  return null;
}

/** Where an admitted entry goes: the game, a host DLL the build supplied, an asset, or nowhere. */
function sortEntries(entries: readonly BundleEntry[], exe: string): [assets: string[], ignored: string[]] {
  const assets: string[] = [];
  const ignored: string[] = [];
  for (const entry of entries) {
    const isFile = entry.kind === BundleEntryKind.File;
    if (!isFile || entry.path === exe || topLevelAngle(entry.path) !== undefined) continue;
    if (isUnderAssets(entry.path)) assets.push(entry.path);
    else ignored.push(entry.path);
  }
  return [assets.sort(), ignored.sort()];
}

/** The refusal for the first entry under assets that a disk ignoring case (or Unicode form) reads as an earlier one's name. */
function assetTwinRefusal(ordered: readonly BundleEntry[]): WindowsRefused | null {
  const seen = new Set<string>();
  for (const entry of ordered) {
    if (!isUnderAssets(entry.path)) continue;
    const key = foldedName(entry.path);
    if (seen.has(key)) return notExecutable(entry.path, WindowsExeProblem.BadPath, MESSAGE.AssetTwice(entry.path));
    seen.add(key);
  }
  return null;
}

/**
 * Admits a Windows build's output, described entry by entry (see {@link admitWindowsOutput} for
 * reading a folder), or names why not. Pure: it reads only `entries`.
 */
export function admitWindowsBundle(entries: readonly BundleEntry[], options: WindowsBundleOptions): WindowsAdmission {
  if (!isExeName(options.exe)) {
    return notExecutable(options.exe, WindowsExeProblem.BadPath, MESSAGE.BadExeName(options.exe));
  }
  const ordered = [...entries].sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)));
  const game = ordered.find((entry) => entry.path === options.exe);
  for (const entry of ordered) {
    if (entry === game && entry.kind === BundleEntryKind.File) {
      if (entry.links > 1) return refused(NativeRefusal.HardLink, entry.path, MESSAGE.HardLink(entry.path));
      continue;
    }
    const refusal = entryRefusal(entry, options.pins);
    if (refusal) return refusal;
  }
  const twin = assetTwinRefusal(ordered);
  if (twin) return twin;
  const judged = gameImage(game, options.exe);
  if ("ok" in judged) return judged;
  const [assets, ignored] = sortEntries(ordered, options.exe);
  const supplied = ordered.flatMap((entry) => {
    const angle = topLevelAngle(entry.path);
    return angle !== undefined && entry.kind === BundleEntryKind.File ? [angle] : [];
  });
  const suppliedAngle = [...new Set(supplied)];
  return {
    ok: true,
    bundle: {
      exe: { path: options.exe, bytes: game?.bytes ?? new Uint8Array(), image: judged.image },
      assets,
      suppliedAngle,
      ignored,
    },
  };
}

/** A Rust executable the PE policy admitted, with its headers. */
export type RustPeAdmission = { ok: true; image: PeImage } | RustBinaryRefusal;

const rustRefused = (refusal: NativeRefusal, problem: RustAdmissionProblem, detail: string): RustBinaryRefusal => ({
  ok: false,
  refusal,
  problem,
  detail,
});

/** Whether `key` (a bare DLL key) is on the Rust allow-list, the network one included for a `[net]` export. */
function rustAllowed(key: string, network: boolean): boolean {
  return RUST_WINDOWS_DLLS.has(key) || API_SET_DLL.test(key) || (network && RUST_WINDOWS_NET_DLLS.has(key));
}

/** Why a Rust image's imports or delay imports are not the policy's, or null: GL first, then DXC, then the allow-list. */
function rustImportRefusal(image: PeImage, network: boolean): RustBinaryRefusal | null {
  const imported = [...image.imports, ...image.delayImports];
  const gl = imported.find((name) => OPENGL_DLLS.has(dllKey(name)) || ANGLE_GL_KEYS.has(dllKey(name)));
  if (gl !== undefined)
    return rustRefused(NativeRefusal.ImportsOpengl32, RustAdmissionProblem.OpenGl, MESSAGE.RustGl(gl));
  const dxc = imported.find((name) => DXC_DLLS.has(dllKey(name)));
  if (dxc !== undefined) {
    return rustRefused(NativeRefusal.ForeignImport, RustAdmissionProblem.DxCompiler, MESSAGE.RustDxc(dxc));
  }
  const foreign = imported.find((name) => {
    const key = bareDllKey(name);
    return key === null || !rustAllowed(key, network);
  });
  if (foreign === undefined) return null;
  return rustRefused(NativeRefusal.ForeignImport, RustAdmissionProblem.ForeignImport, MESSAGE.RustForeign(foreign));
}

/**
 * Admits a Rust · wgpu game's Windows executable from its bytes (M3.5): an x64 PE32+ executable
 * (not a DLL) whose imports and delay imports are bare names of {@link RUST_WINDOWS_DLLS} or API
 * sets, and for a `[net]` game's export (`network`) of {@link RUST_WINDOWS_NET_DLLS}. Pure; never throws.
 */
export function admitRustPe(bytes: Uint8Array, options: { network?: boolean } = {}): RustPeAdmission {
  const read = readPe(bytes);
  if (!read.ok) return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.Unreadable, read.detail);
  const { image } = read;
  if (!isX64Image(image)) {
    const detail = MESSAGE.WrongMachine(image.machine, image.pe32Plus);
    return rustRefused(NativeRefusal.WrongMachine, RustAdmissionProblem.WrongMachine, detail);
  }
  if (image.dll || !image.executable) {
    return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.NotAnExecutable, MESSAGE.NotAnExeImage);
  }
  return rustImportRefusal(image, options.network === true) ?? { ok: true, image };
}

/**
 * Null when `bytes` are the lock's pinned `name`: the digest matches, and it is an x64 PE32+ DLL
 * that imports no desktop OpenGL. Else why not. For the host's own store copies before it writes them.
 */
export function checkWindowsAngleDll(
  name: WindowsAngleDll,
  bytes: Uint8Array,
  pins: WindowsAnglePins,
): WindowsRefused | null {
  if (sha256(bytes) !== pins[name]) return refused(NativeRefusal.AngleDigest, name, MESSAGE.AngleDigest(name));
  const read = readPe(bytes);
  if (!read.ok) return refused(NativeRefusal.AngleDigest, name, read.detail, read.problem);
  const { image } = read;
  if (!isX64Image(image)) {
    const detail = MESSAGE.WrongMachine(image.machine, image.pe32Plus);
    return refused(NativeRefusal.AngleDigest, name, detail, WindowsExeProblem.WrongMachine);
  }
  if (!image.dll) return refused(NativeRefusal.AngleDigest, name, MESSAGE.NotADll, WindowsExeProblem.NotADll);
  const openGl = [...image.imports, ...image.delayImports].find((each) => OPENGL_DLLS.has(dllKey(each)));
  return openGl === undefined ? null : refused(NativeRefusal.ImportsOpengl32, name, MESSAGE.OpenGl(openGl));
}

/** The three DLL pins from a Windows ANGLE `manifest.json` (`files.<name>.sha256`), or null unless all are well formed. */
export function windowsAnglePins(manifest: unknown): WindowsAnglePins | null {
  const files = isJsonObject(manifest) ? manifest.files : null;
  if (!isJsonObject(files)) return null;
  const pin = (name: WindowsAngleDll): string | null => {
    const entry = files[name];
    const digest = isJsonObject(entry) ? entry.sha256 : null;
    return typeof digest === "string" && SHA256_HEX.test(digest) ? digest : null;
  };
  const egl = pin(WindowsAngleDll.Egl);
  const gles = pin(WindowsAngleDll.Gles);
  const d3d = pin(WindowsAngleDll.D3dCompiler);
  if (egl === null || gles === null || d3d === null) return null;
  return { [WindowsAngleDll.Egl]: egl, [WindowsAngleDll.Gles]: gles, [WindowsAngleDll.D3dCompiler]: d3d };
}

/** Reads `handle` from the start: at most `size` bytes, fewer if the file shrank meanwhile. */
async function readUpTo(handle: FileHandle, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let total = 0;
  while (total < size) {
    const { bytesRead } = await handle.read(bytes, total, size - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return bytes.subarray(0, total);
}

/** How many bytes of a file at `relative` the gate reads whole, or 0 when its head is enough. */
function wholeCap(relative: string, exe: string, limits: WindowsBundleLimits): number {
  if (relative === exe) return limits.exeBytes;
  return topLevelAngle(relative) === undefined ? 0 : limits.angleBytes;
}

/** The folder reads {@link admitWindowsOutput} makes: the shared walk's, replaced in tests to stage a swap. */
export type OutputFolderReads = BundleReads;

/** What one file's second open finds, by what stopped it: a link, a non-file, or anything else. */
const OPEN_KIND: Partial<Record<WalkProblem, BundleEntryKind>> = {
  [WalkProblem.Symlink]: BundleEntryKind.Symlink,
  [WalkProblem.Special]: BundleEntryKind.Other,
};

/**
 * One file the walk listed, opened again for its bytes without following a link or blocking on a
 * FIFO. A link, or a node other than the one the walk saw (swapped since), is a `Symlink` entry; a
 * non-file `Other`; an open or read failure `Unreadable`.
 */
async function fileEntry(outDir: string, walked: WalkEntry, cap: number, realRoot: string): Promise<BundleEntry> {
  const entry = (kind: BundleEntryKind, extra: Partial<BundleEntry> = {}): BundleEntry => ({
    path: walked.path,
    kind,
    links: walked.links,
    bytes: new Uint8Array(),
    whole: false,
    ...extra,
  });
  const opened = await openBundleFile(outDir, walked.path, { realRoot });
  if (!opened.ok) return entry(OPEN_KIND[opened.problem] ?? BundleEntryKind.Unreadable);
  const { handle, info } = opened;
  try {
    if (info.dev !== walked.dev || info.ino !== walked.ino) return entry(BundleEntryKind.Symlink);
    const whole = info.size <= cap;
    const bytes = await readUpTo(handle, whole ? info.size : Math.min(info.size, PE_HEAD_BYTES));
    return entry(BundleEntryKind.File, { links: info.nlink, bytes, whole: whole && bytes.byteLength === info.size });
  } catch {
    return entry(BundleEntryKind.Unreadable);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** A walked entry as admission judges it: files opened again for their bytes, the rest by kind. */
const WALK_KIND: Record<Exclude<WalkKind, typeof WalkKind.File>, BundleEntryKind> = {
  [WalkKind.Directory]: BundleEntryKind.Directory,
  [WalkKind.Symlink]: BundleEntryKind.Symlink,
  [WalkKind.Fifo]: BundleEntryKind.Other,
  [WalkKind.Socket]: BundleEntryKind.Other,
  [WalkKind.Device]: BundleEntryKind.Other,
};

/** The refusal a walk that stopped earns: the folder's own state, its size, a swap or a name. */
function walkRefusal(walk: WalkRefused, outDir: string): WindowsRefused {
  const where = walk.path;
  switch (walk.problem) {
    case WalkProblem.NotAFolder:
      return notExecutable(".", WindowsExeProblem.Unreadable, MESSAGE.Unreadable(outDir, MESSAGE.NotAFolder));
    case WalkProblem.TooManyEntries:
      return notExecutable(where, WindowsExeProblem.TooManyEntries, MESSAGE.TooManyEntries("entries"));
    case WalkProblem.TooDeep:
      return notExecutable(where, WindowsExeProblem.TooManyEntries, MESSAGE.TooManyEntries("nested folders"));
    case WalkProblem.Symlink:
    case WalkProblem.Swapped:
      return refused(NativeRefusal.Symlink, where, walk.detail);
    case WalkProblem.HardLink:
      return refused(NativeRefusal.HardLink, where, walk.detail);
    case WalkProblem.BadName:
    case WalkProblem.CaseTwin:
      return notExecutable(where, WindowsExeProblem.BadPath, walk.detail);
    default:
      return notExecutable(where, WindowsExeProblem.Unreadable, walk.detail);
  }
}

/**
 * Reads a Windows build's output folder through the shared bounded walk (links, FIFOs and the like
 * reported, never followed or opened) and then each file without following a link, writing
 * nothing; then admits it as {@link admitWindowsBundle} does. Never throws: what cannot be read is
 * not admitted.
 */
export async function admitWindowsOutput(
  outDir: string,
  options: WindowsBundleOptions & { limits?: Partial<WindowsBundleLimits>; reads?: OutputFolderReads },
): Promise<WindowsAdmission> {
  const limits = { ...WINDOWS_BUNDLE_LIMITS, ...options.limits };
  try {
    const walk = await walkBundle(outDir, {
      limits: { entries: limits.entries, depth: limits.depth },
      reads: options.reads,
      refuse: WALK_REPORT_ONLY,
    });
    if (!walk.ok) return walkRefusal(walk, outDir);
    const realRoot = await realpath(outDir);
    const entries: BundleEntry[] = [];
    for (const walked of walk.entries) {
      if (walked.kind === WalkKind.File) {
        entries.push(await fileEntry(outDir, walked, wholeCap(walked.path, options.exe, limits), realRoot));
      } else {
        entries.push({
          path: walked.path,
          kind: WALK_KIND[walked.kind],
          links: walked.links,
          bytes: new Uint8Array(),
          whole: true,
        });
      }
    }
    return admitWindowsBundle(entries, { exe: options.exe, pins: options.pins });
  } catch (error) {
    return notExecutable(".", WindowsExeProblem.Unreadable, MESSAGE.Unreadable(outDir, errorMessage(error)));
  }
}

/**
 * The headers of the game at `exe` in a Windows build's output folder whose real path is
 * `realRoot`, read as admission reads a file (no link at its name or above it, never blocking, no
 * other hard link, within the executable cap); null when it cannot be read or is no PE image.
 * Admission's refusal says what is wrong with a build; this says what its game imports. Never
 * throws and never writes.
 */
export async function readWindowsExecutable(
  outDir: string,
  exe: string,
  realRoot: string,
  limits: Pick<WindowsBundleLimits, "exeBytes"> = WINDOWS_BUNDLE_LIMITS,
): Promise<PeImage | null> {
  const read = await readBundleFile(outDir, exe, { realRoot, maxBytes: limits.exeBytes });
  if (!read.ok) return null;
  const image = readPe(read.bytes);
  return image.ok ? image.image : null;
}
