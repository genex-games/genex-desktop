/**
 * A pure-TS writer of minimal PE/COFF images for the Windows gate's fixtures (no compiler, so it
 * runs on every CI host). One `.rdata` section holds the import, delay-import and export tables a
 * row asks for, laid out as a linker lays them out: descriptors, thunk arrays, hint/name entries
 * and names. The images are read, never run. `layout` names the offsets a hostile row patches
 * with {@link patched}.
 */

/** `IMAGE_FILE_MACHINE_*` values a fixture may carry. */
export const PeFixtureMachine = { X64: 0x8664, X86: 0x14c, Arm64: 0xaa64 } as const;
export type PeFixtureMachine = (typeof PeFixtureMachine)[keyof typeof PeFixtureMachine];

/** COFF characteristics the writer sets. */
export const PeFixtureFlag = {
  ExecutableImage: 0x0002,
  LargeAddressAware: 0x0020,
  Machine32Bit: 0x0100,
  Dll: 0x2000,
} as const;

/** A section header the writer appends after its own `.rdata` one, for overlap, alignment and adjacency rows. */
export interface PeExtraSection {
  rva: number;
  virtualSize: number;
  rawSize: number;
  rawPointer: number;
  /** Raw data written at `rawPointer`; the file grows to hold `rawSize` bytes there. Omitted, nothing is written. */
  data?: Uint8Array;
}

/** What one fixture image holds. Every list is written in order; an empty list leaves its directory out. */
export interface PeSpec {
  /** Default x64, or x86 when `pe32`. */
  machine?: number;
  /** A PE32 (32-bit) optional header instead of PE32+. */
  pe32?: boolean;
  dll?: boolean;
  /** COFF characteristics, replacing what `dll` and `pe32` imply. */
  characteristics?: number;
  /** DLL names the import directory names, one by-name function each. */
  imports?: readonly string[];
  /** DLL names the delay-import directory names. */
  delayImports?: readonly string[];
  /** Delay descriptor attributes: 1 (names are RVAs, the default) or 0 (the old form: VAs, PE32 only). */
  delayAttributes?: number;
  exports?: readonly string[];
  extraSections?: readonly PeExtraSection[];
}

/** File offsets (and the one section's placement) inside a written image. */
export interface PeLayout {
  /** The `PE\0\0` signature. */
  pe: number;
  /** `NumberOfSections` (u16). */
  sectionCount: number;
  optional: number;
  /** `SizeOfOptionalHeader` (u16). */
  optionalSize: number;
  /** `NumberOfRvaAndSizes` (u32). */
  directoryCount: number;
  /** Data directory 0; directory `n` is at `directories + 8 * n` (RVA, then size). */
  directories: number;
  sectionTable: number;
  section: { rva: number; offset: number; rawSize: number; virtualSize: number };
  /** The first import descriptor, or null when there are no imports. */
  importTable: number | null;
  delayTable: number | null;
  exportDirectory: number | null;
  imageBase: bigint;
}

const DOS_HEADER_BYTES = 0x40;
const LFANEW_AT = 0x3c;
const COFF_BYTES = 20;
const OPTIONAL_PE32_PLUS_BYTES = 240;
const OPTIONAL_PE32_BYTES = 224;
const SECTION_HEADER_BYTES = 40;
const SECTION_RVA = 0x1000;
const SECTION_ALIGNMENT = 0x1000;
const FILE_ALIGNMENT = 0x200;
const HEADERS_BYTES = 0x400;
const IMPORT_DESCRIPTOR_BYTES = 20;
const DELAY_DESCRIPTOR_BYTES = 32;
const EXPORT_DIRECTORY_BYTES = 40;
const DIRECTORY_COUNT = 16;
const DIRECTORY = { Export: 0, Import: 1, DelayImport: 13 } as const;
const IMAGE_BASE = { Pe32Plus: 0x1_4000_0000n, Pe32: 0x40_0000n } as const;
const MAGIC = { Pe32: 0x10b, Pe32Plus: 0x20b } as const;
const RDATA_CHARACTERISTICS = 0x4000_0040;
const EXPORT_MODULE = "fixture.dll";

const align = (value: number, to: number) => Math.ceil(value / to) * to;
const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

/** The section's contents, allocated before anything is written so every RVA is known. */
interface Plan {
  size: number;
  importTable: number | null;
  delayTable: number | null;
  exportDirectory: number | null;
  importThunks: Array<{ ilt: number; iat: number }>;
  delayThunks: Array<{ int: number; iat: number; handle: number }>;
  hintName: number;
  importNames: number[];
  delayNames: number[];
  exportNames: number[];
  exportModule: number;
  exportTables: { functions: number; names: number; ordinals: number };
}

function planSection(spec: PeSpec, thunk: number): Plan {
  const imports = spec.imports ?? [];
  const delays = spec.delayImports ?? [];
  const exports = spec.exports ?? [];
  let size = 0;
  const alloc = (bytes: number, to = 8) => {
    size = align(size, to);
    const at = size;
    size += bytes;
    return at;
  };
  const importTable = imports.length > 0 ? alloc((imports.length + 1) * IMPORT_DESCRIPTOR_BYTES) : null;
  const delayTable = delays.length > 0 ? alloc((delays.length + 1) * DELAY_DESCRIPTOR_BYTES) : null;
  const exportDirectory = exports.length > 0 ? alloc(EXPORT_DIRECTORY_BYTES) : null;
  const importThunks = imports.map(() => ({ ilt: alloc(2 * thunk), iat: alloc(2 * thunk) }));
  const delayThunks = delays.map(() => ({ int: alloc(2 * thunk), iat: alloc(2 * thunk), handle: alloc(thunk) }));
  const hintName = alloc(4, 2);
  const exportTables = {
    functions: alloc(4 * exports.length),
    names: alloc(4 * exports.length),
    ordinals: alloc(2 * exports.length),
  };
  const importNames = imports.map((name) => alloc(name.length + 1, 1));
  const delayNames = delays.map((name) => alloc(name.length + 1, 1));
  const exportNames = exports.map((name) => alloc(name.length + 1, 1));
  const exportModule = alloc(EXPORT_MODULE.length + 1, 1);
  return {
    size,
    importTable,
    delayTable,
    exportDirectory,
    importThunks,
    delayThunks,
    hintName,
    importNames,
    delayNames,
    exportNames,
    exportModule,
    exportTables,
  };
}

/** Writes the import, delay-import and export tables into the section at `base`. */
function writeTables(bytes: Uint8Array, view: DataView, base: number, spec: PeSpec, plan: Plan, thunk: number): void {
  const rva = (offset: number) => SECTION_RVA + offset;
  const u32 = (offset: number, value: number) => view.setUint32(base + offset, value >>> 0, true);
  const writeThunk = (offset: number, value: number) =>
    thunk === 8 ? view.setBigUint64(base + offset, BigInt(value), true) : u32(offset, value);
  const text = (offset: number, value: string) => bytes.set(ascii(value), base + offset);
  const imports = spec.imports ?? [];
  const delays = spec.delayImports ?? [];
  const exports = spec.exports ?? [];
  text(plan.hintName + 2, "f");
  imports.forEach((name, index) => {
    const at = (plan.importTable ?? 0) + index * IMPORT_DESCRIPTOR_BYTES;
    const thunks = plan.importThunks[index];
    const nameAt = plan.importNames[index] ?? 0;
    if (!thunks) return;
    writeThunk(thunks.ilt, rva(plan.hintName));
    writeThunk(thunks.iat, rva(plan.hintName));
    u32(at, rva(thunks.ilt));
    u32(at + 12, rva(nameAt));
    u32(at + 16, rva(thunks.iat));
    text(nameAt, name);
  });
  const attributes = spec.delayAttributes ?? 1;
  const imageBase = Number(spec.pe32 ? IMAGE_BASE.Pe32 : IMAGE_BASE.Pe32Plus);
  const address = (offset: number) => (attributes & 1 ? rva(offset) : imageBase + rva(offset));
  delays.forEach((name, index) => {
    const at = (plan.delayTable ?? 0) + index * DELAY_DESCRIPTOR_BYTES;
    const thunks = plan.delayThunks[index];
    const nameAt = plan.delayNames[index] ?? 0;
    if (!thunks) return;
    writeThunk(thunks.int, rva(plan.hintName));
    u32(at, attributes);
    u32(at + 4, address(nameAt));
    u32(at + 8, address(thunks.handle));
    u32(at + 12, address(thunks.iat));
    u32(at + 16, address(thunks.int));
    text(nameAt, name);
  });
  if (plan.exportDirectory === null) return;
  const directory = plan.exportDirectory;
  u32(directory + 12, rva(plan.exportModule));
  u32(directory + 16, 1);
  u32(directory + 20, exports.length);
  u32(directory + 24, exports.length);
  u32(directory + 28, rva(plan.exportTables.functions));
  u32(directory + 32, rva(plan.exportTables.names));
  u32(directory + 36, rva(plan.exportTables.ordinals));
  text(plan.exportModule, EXPORT_MODULE);
  exports.forEach((name, index) => {
    const nameAt = plan.exportNames[index] ?? 0;
    u32(plan.exportTables.functions + 4 * index, SECTION_RVA);
    u32(plan.exportTables.names + 4 * index, rva(nameAt));
    view.setUint16(base + plan.exportTables.ordinals + 2 * index, index, true);
    text(nameAt, name);
  });
}

function defaultCharacteristics(spec: PeSpec): number {
  const width = spec.pe32 ? PeFixtureFlag.Machine32Bit : PeFixtureFlag.LargeAddressAware;
  const dll = spec.dll ? PeFixtureFlag.Dll : 0;
  return PeFixtureFlag.ExecutableImage | width | dll;
}

/** Writes the DOS stub, `PE\0\0`, the COFF header and the optional header with its directories. */
function writeHeaders(view: DataView, spec: PeSpec, plan: Plan, extraSections: number): void {
  const pe32 = spec.pe32 ?? false;
  const pe = DOS_HEADER_BYTES;
  const optional = pe + 4 + COFF_BYTES;
  const directories = optional + (pe32 ? 96 : 112);
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(LFANEW_AT, pe, true);
  view.setUint32(pe, 0x4550, true);
  view.setUint16(pe + 4, spec.machine ?? (pe32 ? PeFixtureMachine.X86 : PeFixtureMachine.X64), true);
  view.setUint16(pe + 6, 1 + extraSections, true);
  view.setUint16(pe + 20, pe32 ? OPTIONAL_PE32_BYTES : OPTIONAL_PE32_PLUS_BYTES, true);
  view.setUint16(pe + 22, spec.characteristics ?? defaultCharacteristics(spec), true);
  view.setUint16(optional, pe32 ? MAGIC.Pe32 : MAGIC.Pe32Plus, true);
  view.setUint32(optional + 16, SECTION_RVA, true);
  if (pe32) view.setUint32(optional + 28, Number(IMAGE_BASE.Pe32), true);
  else view.setBigUint64(optional + 24, IMAGE_BASE.Pe32Plus, true);
  view.setUint32(optional + 32, SECTION_ALIGNMENT, true);
  view.setUint32(optional + 36, FILE_ALIGNMENT, true);
  view.setUint16(optional + 40, 6, true);
  view.setUint16(optional + 48, 6, true);
  view.setUint32(optional + 56, SECTION_RVA + align(Math.max(plan.size, 1), SECTION_ALIGNMENT), true);
  view.setUint32(optional + 60, HEADERS_BYTES, true);
  view.setUint16(optional + 68, 3, true);
  view.setUint32(optional + (pe32 ? 92 : 108), DIRECTORY_COUNT, true);
  const directory = (index: number, offset: number | null, size: number) => {
    if (offset === null) return;
    view.setUint32(directories + 8 * index, SECTION_RVA + offset, true);
    view.setUint32(directories + 8 * index + 4, size, true);
  };
  directory(DIRECTORY.Export, plan.exportDirectory, EXPORT_DIRECTORY_BYTES);
  directory(DIRECTORY.Import, plan.importTable, ((spec.imports ?? []).length + 1) * IMPORT_DESCRIPTOR_BYTES);
  directory(DIRECTORY.DelayImport, plan.delayTable, ((spec.delayImports ?? []).length + 1) * DELAY_DESCRIPTOR_BYTES);
}

/** Writes one section header at `at`. */
function writeSectionHeader(bytes: Uint8Array, view: DataView, at: number, name: string, section: PeExtraSection) {
  bytes.set(ascii(name), at);
  view.setUint32(at + 8, section.virtualSize, true);
  view.setUint32(at + 12, section.rva, true);
  view.setUint32(at + 16, section.rawSize, true);
  view.setUint32(at + 20, section.rawPointer, true);
  view.setUint32(at + 36, RDATA_CHARACTERISTICS, true);
}

/** A minimal PE image for `spec` and the offsets of its parts. */
export function writePe(spec: PeSpec = {}): { bytes: Uint8Array; layout: PeLayout } {
  const pe32 = spec.pe32 ?? false;
  const thunk = pe32 ? 4 : 8;
  const plan = planSection(spec, thunk);
  const rawSize = align(Math.max(plan.size, 1), FILE_ALIGNMENT);
  const extra = spec.extraSections ?? [];
  const extraEnd = extra.reduce((end, each) => (each.data ? Math.max(end, each.rawPointer + each.rawSize) : end), 0);
  const bytes = new Uint8Array(Math.max(HEADERS_BYTES + rawSize, extraEnd));
  const view = new DataView(bytes.buffer);
  for (const each of extra) if (each.data) bytes.set(each.data.subarray(0, each.rawSize), each.rawPointer);
  writeHeaders(view, spec, plan, extra.length);
  const pe = DOS_HEADER_BYTES;
  const optional = pe + 4 + COFF_BYTES;
  const sectionTable = optional + (pe32 ? OPTIONAL_PE32_BYTES : OPTIONAL_PE32_PLUS_BYTES);
  const own = { rva: SECTION_RVA, virtualSize: plan.size, rawSize, rawPointer: HEADERS_BYTES };
  writeSectionHeader(bytes, view, sectionTable, ".rdata", own);
  extra.forEach((section, index) => {
    writeSectionHeader(bytes, view, sectionTable + SECTION_HEADER_BYTES * (index + 1), ".extra", section);
  });
  writeTables(bytes, view, HEADERS_BYTES, spec, plan, thunk);
  const offset = (at: number | null) => (at === null ? null : HEADERS_BYTES + at);
  return {
    bytes,
    layout: {
      pe,
      sectionCount: pe + 6,
      optional,
      optionalSize: pe + 20,
      directoryCount: optional + (pe32 ? 92 : 108),
      directories: optional + (pe32 ? 96 : 112),
      sectionTable,
      section: { rva: SECTION_RVA, offset: HEADERS_BYTES, rawSize, virtualSize: plan.size },
      importTable: offset(plan.importTable),
      delayTable: offset(plan.delayTable),
      exportDirectory: offset(plan.exportDirectory),
      imageBase: pe32 ? IMAGE_BASE.Pe32 : IMAGE_BASE.Pe32Plus,
    },
  };
}

/** A copy of `bytes` with an unsigned little-endian `width`-byte `value` written at `offset`. */
export function patched(bytes: Uint8Array, offset: number, width: 2 | 4, value: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  if (width === 2) view.setUint16(offset, value, true);
  else view.setUint32(offset, value >>> 0, true);
  return copy;
}

/** The resource directory's index among the optional header's data directories, and RT_MANIFEST's type id. */
const RESOURCE_DIRECTORY = 2;
const RT_MANIFEST = 24;
/** A resource directory entry whose offset names another directory (the rest is the offset). */
const RESOURCE_SUBDIRECTORY = 0x8000_0000;
const RESOURCE_DIRECTORY_HEADER_BYTES = 16;
const RESOURCE_ENTRY_BYTES = 8;

/** The file offset of `rva` through the section table, or null when no section holds it. */
function fileOffsetOf(view: DataView, sections: number, count: number, rva: number): number | null {
  for (let index = 0; index < count; index++) {
    const at = sections + index * SECTION_HEADER_BYTES;
    const size = Math.max(view.getUint32(at + 8, true), view.getUint32(at + 16, true));
    const start = view.getUint32(at + 12, true);
    if (rva >= start && rva < start + size) return rva - start + view.getUint32(at + 20, true);
  }
  return null;
}

/** The entries of the resource directory at `offset` (relative to the resource section's start). */
function resourceEntries(view: DataView, base: number, offset: number): Array<{ id: number; target: number }> {
  const at = base + offset;
  const count = view.getUint16(at + 12, true) + view.getUint16(at + 14, true);
  return Array.from({ length: count }, (_, index) => {
    const entry = at + RESOURCE_DIRECTORY_HEADER_BYTES + index * RESOURCE_ENTRY_BYTES;
    return { id: view.getUint32(entry, true), target: view.getUint32(entry + 4, true) };
  });
}

/**
 * A PE32+ image's application manifest (its first RT_MANIFEST resource) as text, or null when it
 * has none: read from the resource directory, type then name then language, as Windows' loader does.
 */
export function peManifest(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(LFANEW_AT, true);
  const sectionCount = view.getUint16(pe + 6, true);
  const optional = pe + 4 + COFF_BYTES;
  const sections = optional + view.getUint16(pe + 20, true);
  const directory = optional + 112 + RESOURCE_DIRECTORY * 8;
  const rva = view.getUint32(directory, true);
  if (rva === 0) return null;
  const base = fileOffsetOf(view, sections, sectionCount, rva);
  if (base === null) return null;
  const manifest = resourceEntries(view, base, 0).find((entry) => entry.id === RT_MANIFEST);
  if (!manifest) return null;
  let target = manifest.target;
  while (target & RESOURCE_SUBDIRECTORY) {
    const [first] = resourceEntries(view, base, target & ~RESOURCE_SUBDIRECTORY);
    if (!first) return null;
    target = first.target;
  }
  const data = fileOffsetOf(view, sections, sectionCount, view.getUint32(base + target, true));
  if (data === null) return null;
  return Buffer.from(bytes.subarray(data, data + view.getUint32(base + target + 4, true))).toString("utf8");
}
