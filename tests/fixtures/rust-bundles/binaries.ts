/**
 * Synthetic Rust · wgpu binaries for the admission gates' rows (M3.5), one per destination format,
 * written from `m2-binaries.json`: what the pond example linked when M2 built it for each
 * destination. A row starts from a destination's real link set and changes one thing, so a
 * refusal names exactly that thing and an admission proves the allow-list admits a real build.
 * The images are read by the gates, never run.
 */
import { readFileSync } from "node:fs";
import { ElfMachine, ElfType, programHeaderField, ELF_PROGRAM_HEADER, writeElf } from "../../helpers/elf.ts";
import { LoadCommand, loadCommand, MachOFile, machO } from "../../helpers/macho.ts";
import { writePe } from "../../helpers/pe.ts";

/** The facts `m2-binaries.json` records per destination build. */
export interface M2Binaries {
  mac: { dylibs: string[]; minos: string };
  "ios-device": { dylibs: string[]; minos: string };
  "ios-simulator": { dylibs: string[]; minos: string };
  windows: { imports: string[]; delayImports: string[] };
  linux: { needed: string[]; interpreter: string; versionNeeds: Array<{ file: string; names: string[] }> };
  android: { needed: string[]; loadAlignments: number[] };
  "android-executable": { needed: string[]; interpreter: string; loadAlignments: number[] };
  web: { importModules: string[] };
}

/** The real link sets, as committed. */
export const M2: M2Binaries = JSON.parse(
  readFileSync(new URL("./m2-binaries.json", import.meta.url), "utf8"),
).binaries;

/** `LC_BUILD_VERSION` platforms, as `<mach-o/loader.h>` numbers them. */
export const ApplePlatform = { MacOs: 1, Ios: 2, IosSimulator: 7 } as const;
const LC_BUILD_VERSION = 0x32;
const BUILD_VERSION_BYTES = 24;

/** Mach-O's packed `xxxx.yy.zz` version of `"major.minor"`. */
export function packedVersion(text: string): number {
  const [major = 0, minor = 0] = text.split(".").map(Number);
  return (major << 16) | (minor << 8);
}

/** One `LC_BUILD_VERSION` naming `platform` and `minos`, with no tools. */
export function buildVersion(platform: number, minos: string): Buffer {
  const bytes = Buffer.alloc(BUILD_VERSION_BYTES);
  bytes.writeUInt32LE(LC_BUILD_VERSION, 0);
  bytes.writeUInt32LE(BUILD_VERSION_BYTES, 4);
  bytes.writeUInt32LE(platform, 8);
  bytes.writeUInt32LE(packedVersion(minos), 12);
  bytes.writeUInt32LE(packedVersion("26.5"), 16);
  return bytes;
}

/** What an Apple row may change from a destination's real build. */
export interface AppleSpec {
  dylibs?: string[];
  rpaths?: string[];
  environment?: string[];
  /** `null` writes no `LC_BUILD_VERSION`. */
  platform?: number | null;
  minos?: string;
  fileType?: number;
  /** Bytes after the load commands (a transport symbol's name, for the scan's rows). */
  trailer?: string;
}

/** A thin arm64 Mach-O image: the destination's real imports unless `spec` says otherwise. */
export function appleBinary(base: { dylibs: string[]; minos: string }, platform: number, spec: AppleSpec = {}): Buffer {
  const commands = [
    ...(spec.dylibs ?? base.dylibs).map((value) => loadCommand({ cmd: LoadCommand.LoadDylib, value })),
    ...(spec.rpaths ?? []).map((value) => loadCommand({ cmd: LoadCommand.Rpath, value })),
    ...(spec.environment ?? []).map((value) => loadCommand({ cmd: LoadCommand.DyldEnvironment, value })),
  ];
  const named = spec.platform === undefined ? platform : spec.platform;
  if (named !== null) commands.push(buildVersion(named, spec.minos ?? base.minos));
  const image = machO({ fileType: spec.fileType ?? MachOFile.Execute }, commands);
  return spec.trailer === undefined ? image : Buffer.concat([image, Buffer.from(spec.trailer, "latin1")]);
}

/** The Mac build as M2 linked it, with `spec`'s change. */
export const macBinary = (spec: AppleSpec = {}): Buffer => appleBinary(M2.mac, ApplePlatform.MacOs, spec);
/** The iOS device build as M2 linked it, with `spec`'s change. */
export const iosBinary = (spec: AppleSpec = {}): Buffer => appleBinary(M2["ios-device"], ApplePlatform.Ios, spec);
/** The iOS Simulator build as M2 linked it, with `spec`'s change. */
export const iosSimulatorBinary = (spec: AppleSpec = {}): Buffer =>
  appleBinary(M2["ios-simulator"], ApplePlatform.IosSimulator, spec);

/** What a Windows row may change from the real build. */
export interface WindowsSpec {
  imports?: string[];
  delayImports?: string[];
  machine?: number;
  dll?: boolean;
  trailer?: string;
}

/** An x64 PE32+ executable: the real imports unless `spec` says otherwise. */
export function windowsBinary(spec: WindowsSpec = {}): Buffer {
  const { bytes } = writePe({
    imports: spec.imports ?? M2.windows.imports,
    delayImports: spec.delayImports ?? M2.windows.delayImports,
    ...(spec.machine === undefined ? {} : { machine: spec.machine }),
    ...(spec.dll === undefined ? {} : { dll: spec.dll }),
  });
  const image = Buffer.from(bytes);
  return spec.trailer === undefined ? image : Buffer.concat([image, Buffer.from(spec.trailer, "latin1")]);
}

/** What an ELF row may change from the real build. */
export interface ElfRowSpec {
  needed?: string[];
  interpreter?: string | null;
  runpath?: string[];
  rpath?: string[];
  versionNeeds?: Array<{ file: string; names: string[] }>;
  machine?: number;
  type?: number;
  /** Every PT_LOAD's `p_align`. */
  align?: number;
  trailer?: string;
}

/** `bytes` with `trailer` after them, when there is one. */
const withTrailer = (bytes: Buffer, trailer: string | undefined): Buffer =>
  trailer === undefined ? bytes : Buffer.concat([bytes, Buffer.from(trailer, "latin1")]);

/** An x86-64 glibc executable: the real Linux build's imports and versions unless `spec` says otherwise. */
export function linuxBinary(spec: ElfRowSpec = {}): Buffer {
  const { bytes } = writeElf({
    ...(spec.type === undefined ? {} : { type: spec.type }),
    ...(spec.machine === undefined ? {} : { machine: spec.machine }),
    interpreter: spec.interpreter === undefined ? M2.linux.interpreter : spec.interpreter,
    needed: spec.needed ?? M2.linux.needed,
    runpath: spec.runpath ?? [],
    rpath: spec.rpath ?? [],
    versionNeeds: spec.versionNeeds ?? M2.linux.versionNeeds,
  });
  return withTrailer(bytes, spec.trailer);
}

/** An arm64 bionic shared object aligned to 16 KB: the real Android build's imports unless `spec` says otherwise. */
export function androidBinary(spec: ElfRowSpec = {}): Buffer {
  const { bytes, layout } = writeElf({
    type: spec.type ?? ElfType.Shared,
    machine: spec.machine ?? ElfMachine.Aarch64,
    interpreter: spec.interpreter ?? null,
    needed: spec.needed ?? M2.android.needed,
    runpath: spec.runpath ?? [],
    rpath: spec.rpath ?? [],
    versionNeeds: spec.versionNeeds ?? [],
  });
  const align = spec.align ?? M2.android.loadAlignments[0] ?? 0;
  bytes.writeBigUInt64LE(BigInt(align), programHeaderField(layout, layout.segment.load, ELF_PROGRAM_HEADER.Align));
  return withTrailer(bytes, spec.trailer);
}

/** One wasm import: its module, its name and its kind byte (0 function, 1 table, 2 memory, 3 global). */
export interface WasmImportSpec {
  module: string;
  name: string;
  kind?: number;
}

/** What a wasm row holds besides its type section and a one-page memory. */
export interface WasmSpec {
  imports?: WasmImportSpec[];
  exports?: string[];
  /** Custom sections by name and payload. */
  custom?: Array<{ name: string; payload: string }>;
}

/** An unsigned LEB128. */
function leb(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
}

const wasmName = (text: string): Buffer => {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([leb(bytes.length), bytes]);
};
const section = (id: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([id]), leb(body.length), body]);
const vector = (items: Buffer[]): Buffer => Buffer.concat([leb(items.length), ...items]);

/** The import of one wasm-bindgen glue function, as the real web build's module names it. */
export const glueImport = (name: string): WasmImportSpec => ({ module: M2.web.importModules[0] ?? "", name });

/**
 * A valid wasm module: one `() -> ()` type, `spec`'s imports (functions use that type; a memory
 * import one page), one page of memory exported as `memory`, each export naming function 0.
 */
export function wasmBinary(spec: WasmSpec = {}): Buffer {
  const imports = spec.imports ?? [glueImport("__wbindgen_throw")];
  const importEntry = (entry: WasmImportSpec): Buffer => {
    const kind = entry.kind ?? 0;
    const description = kind === 2 ? Buffer.from([0x00, 0x01]) : leb(0);
    return Buffer.concat([wasmName(entry.module), wasmName(entry.name), Buffer.from([kind]), description]);
  };
  const exports = [
    Buffer.concat([wasmName("memory"), Buffer.from([0x02]), leb(0)]),
    ...(spec.exports ?? []).map((name) => Buffer.concat([wasmName(name), Buffer.from([0x00]), leb(0)])),
  ];
  const parts = [
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    section(1, vector([Buffer.from([0x60, 0x00, 0x00])])),
    section(2, vector(imports.map(importEntry))),
    section(5, vector([Buffer.from([0x00, 0x01])])),
    section(7, vector(exports)),
    ...(spec.custom ?? []).map((custom) =>
      section(0, Buffer.concat([wasmName(custom.name), Buffer.from(custom.payload, "latin1")])),
    ),
  ];
  return Buffer.concat(parts);
}
