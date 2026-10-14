/**
 * A minimal ELF64 writer for the Linux bundle gate's fixtures: no compiler, so the rows run on
 * every host. It lays out what the dynamic loader reads and nothing else: the header, program
 * headers (`PT_INTERP`, one `PT_LOAD` over the whole file, `PT_DYNAMIC`), the interpreter, a
 * string table, `.gnu.version_r` entries and the dynamic array. `layout` names where each part
 * landed, so a hostile row can corrupt one field of an otherwise valid file.
 */

/** Byte offsets of the ELF64 header fields a hostile row corrupts. */
export const ELF_HEADER = {
  Class: 4,
  Data: 5,
  Version: 6,
  Type: 16,
  Machine: 18,
  ProgramHeaderOffset: 32,
  ProgramHeaderSize: 54,
  ProgramHeaderCount: 56,
} as const;

/** Byte offsets inside one 56-byte program header. */
export const ELF_PROGRAM_HEADER = { Type: 0, Offset: 8, Vaddr: 16, FileSize: 32, MemSize: 40, Align: 48 } as const;

/** `e_type` values. */
export const ElfType = { Relocatable: 1, Executable: 2, Shared: 3, Core: 4 } as const;

/** `e_machine` values. */
export const ElfMachine = { X86: 3, X64: 62, Aarch64: 183 } as const;

/** `p_type` values. */
export const ElfSegment = { Load: 1, Dynamic: 2, Interp: 3, ProgramHeaders: 6 } as const;

/** `d_tag` values. */
export const ElfTag = {
  Null: 0,
  Needed: 1,
  PltRelSz: 2,
  PltGot: 3,
  StrTab: 5,
  SymTab: 6,
  Rela: 7,
  StrSz: 10,
  SoName: 14,
  RPath: 15,
  Debug: 21,
  RunPath: 29,
  Flags: 30,
  GnuHash: 0x6ffffef5,
  VerSym: 0x6ffffff0,
  Flags1: 0x6ffffffb,
  VerNeed: 0x6ffffffe,
  VerNeedNum: 0x6fffffff,
  DepAudit: 0x6ffffefb,
  Audit: 0x6ffffefc,
  Auxiliary: 0x7ffffffd,
  Filter: 0x7fffffff,
} as const;

/** The x86_64 glibc loader, as zig and every distribution's toolchain write it. */
export const X64_INTERPRETER = "/lib64/ld-linux-x86-64.so.2";

/** One `.gnu.version_r` entry: a library and the version names needed from it. */
export interface ElfVersionNeedSpec {
  file: string;
  names: string[];
}

/** What the fixture says; every field defaults to a game linked for glibc 2.28 with `RUNPATH=$ORIGIN`. */
export interface ElfSpec {
  type?: number;
  machine?: number;
  /** `PT_INTERP`, or null for none. */
  interpreter?: string | null;
  needed?: string[];
  soname?: string | null;
  runpath?: string[];
  rpath?: string[];
  versionNeeds?: ElfVersionNeedSpec[];
  /** False writes no `PT_DYNAMIC` (a static executable). */
  dynamic?: boolean;
  /** Extra dynamic entries written before `DT_NULL`, as `[tag, value]`; a string value goes into the string table and is written as its index. */
  extraDynamic?: Array<[number, number | string]>;
  /** A `PT_PHDR` first, at the program headers' address plus `vaddrDelta`; null writes none. */
  programHeaderSegment?: { vaddrDelta: number } | null;
  /** `PT_LOAD`s after the one over the whole file, placed relative to that file's end. */
  extraLoads?: ElfExtraLoad[];
  /** True writes a copy of the program headers past every loaded byte and points `e_phoff` at it. */
  programHeadersPastLoads?: boolean;
}

/** A second `PT_LOAD`: its address and file offset past the end of the main load, which the file is padded to hold. */
export interface ElfExtraLoad {
  vaddrPastEnd: number;
  offsetPastEnd: number;
  filesz: number;
}

/** Where the writer put each part, as file offsets (the file maps at `base`, offset 0). */
export interface ElfLayout {
  base: number;
  programHeaders: number;
  programHeaderCount: number;
  /** Index of each program header by type. */
  segment: { phdr: number | null; interp: number | null; load: number; dynamic: number | null };
  interpreter: number | null;
  strtab: number;
  strsz: number;
  verneed: number | null;
  dynamic: number | null;
  /** The dynamic entries in file order, `DT_NULL` last. */
  dynamicEntries: Array<[number, number]>;
}

/** The bytes of one fixture and where its parts are. */
export interface ElfFixture {
  bytes: Buffer;
  layout: ElfLayout;
}

const HEADER_BYTES = 64;
const PROGRAM_HEADER_BYTES = 56;
const DYNAMIC_BYTES = 16;
const VERNEED_BYTES = 16;
const VERNAUX_BYTES = 16;
const EXEC_BASE = 0x400000;

const DEFAULTS: Required<ElfSpec> = {
  type: ElfType.Executable,
  machine: ElfMachine.X64,
  interpreter: X64_INTERPRETER,
  needed: ["libGLESv2.so", "libm.so.6", "libc.so.6"],
  soname: null,
  runpath: ["$ORIGIN"],
  rpath: [],
  versionNeeds: [
    { file: "libm.so.6", names: ["GLIBC_2.2.5"] },
    { file: "libc.so.6", names: ["GLIBC_2.2.5", "GLIBC_2.3", "GLIBC_2.17", "GLIBC_2.28"] },
  ],
  dynamic: true,
  extraDynamic: [],
  programHeaderSegment: null,
  extraLoads: [],
  programHeadersPastLoads: false,
};

/** The System V ELF hash of a version name (`vna_hash`). */
function elfHash(name: string): number {
  let hash = 0;
  for (const byte of Buffer.from(name, "latin1")) {
    hash = ((hash << 4) + byte) >>> 0;
    const high = hash & 0xf0000000;
    if (high !== 0) hash ^= high >>> 24;
    hash = (hash & ~high) >>> 0;
  }
  return hash;
}

/** A string table that hands out each string's index once. */
function stringTable(): { add(text: string): number; bytes(): Buffer } {
  const parts: Buffer[] = [Buffer.from([0])];
  const seen = new Map<string, number>();
  let size = 1;
  return {
    add(text) {
      const known = seen.get(text);
      if (known !== undefined) return known;
      const at = size;
      const encoded = Buffer.concat([Buffer.from(text, "latin1"), Buffer.from([0])]);
      parts.push(encoded);
      size += encoded.length;
      seen.set(text, at);
      return at;
    },
    bytes: () => Buffer.concat(parts),
  };
}

/** `.gnu.version_r` for `needs`, with string indexes from `strings`. */
function versionNeeds(needs: ElfVersionNeedSpec[], strings: ReturnType<typeof stringTable>): Buffer {
  const out: Buffer[] = [];
  let index = 2;
  needs.forEach((need, at) => {
    const entry = Buffer.alloc(VERNEED_BYTES);
    const last = at === needs.length - 1;
    entry.writeUInt16LE(1, 0);
    entry.writeUInt16LE(need.names.length, 2);
    entry.writeUInt32LE(strings.add(need.file), 4);
    entry.writeUInt32LE(VERNEED_BYTES, 8);
    entry.writeUInt32LE(last ? 0 : VERNEED_BYTES + need.names.length * VERNAUX_BYTES, 12);
    out.push(entry);
    need.names.forEach((name, n) => {
      const aux = Buffer.alloc(VERNAUX_BYTES);
      aux.writeUInt32LE(elfHash(name), 0);
      aux.writeUInt16LE(0, 4);
      aux.writeUInt16LE(index++, 6);
      aux.writeUInt32LE(strings.add(name), 8);
      aux.writeUInt32LE(n === need.names.length - 1 ? 0 : VERNAUX_BYTES, 12);
      out.push(aux);
    });
  });
  return Buffer.concat(out);
}

const align8 = (value: number): number => Math.ceil(value / 8) * 8;

/** The dynamic entries `spec` names, before the string table's own and `DT_NULL`. */
function namedEntries(s: Required<ElfSpec>, strings: ReturnType<typeof stringTable>): Array<[number, number]> {
  const entries: Array<[number, number]> = [];
  for (const name of s.needed) entries.push([ElfTag.Needed, strings.add(name)]);
  if (s.soname !== null) entries.push([ElfTag.SoName, strings.add(s.soname)]);
  for (const name of s.rpath) entries.push([ElfTag.RPath, strings.add(name)]);
  for (const name of s.runpath) entries.push([ElfTag.RunPath, strings.add(name)]);
  return entries;
}

/** The ELF64 header: identification, type, machine, entry and the program header table's place. */
function writeHeader(bytes: Buffer, s: Required<ElfSpec>, entry: number, programHeaderCount: number): void {
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  bytes.writeUInt16LE(s.type, ELF_HEADER.Type);
  bytes.writeUInt16LE(s.machine, ELF_HEADER.Machine);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(BigInt(entry), 24);
  bytes.writeBigUInt64LE(BigInt(HEADER_BYTES), ELF_HEADER.ProgramHeaderOffset);
  bytes.writeUInt16LE(HEADER_BYTES, 52);
  bytes.writeUInt16LE(PROGRAM_HEADER_BYTES, ELF_HEADER.ProgramHeaderSize);
  bytes.writeUInt16LE(programHeaderCount, ELF_HEADER.ProgramHeaderCount);
  bytes.writeUInt16LE(64, 58);
}

/** Writes program headers in order after the ELF header; each call returns the header's index. */
function segmentWriter(
  bytes: Buffer,
  base: number,
): (type: number, offset: number, size: number, vaddr?: number) => number {
  let next = 0;
  return (type, offset, size, vaddr = base + offset) => {
    const at = HEADER_BYTES + next * PROGRAM_HEADER_BYTES;
    bytes.writeUInt32LE(type, at + ELF_PROGRAM_HEADER.Type);
    bytes.writeUInt32LE(type === ElfSegment.Load ? 6 : 4, at + 4);
    bytes.writeBigUInt64LE(BigInt(offset), at + ELF_PROGRAM_HEADER.Offset);
    bytes.writeBigUInt64LE(BigInt(vaddr), at + ELF_PROGRAM_HEADER.Vaddr);
    bytes.writeBigUInt64LE(BigInt(vaddr), at + 24);
    bytes.writeBigUInt64LE(BigInt(size), at + ELF_PROGRAM_HEADER.FileSize);
    bytes.writeBigUInt64LE(BigInt(size), at + ELF_PROGRAM_HEADER.MemSize);
    bytes.writeBigUInt64LE(BigInt(type === ElfSegment.Load ? 0x1000 : 8), at + 48);
    return next++;
  };
}

/** The dynamic array's bytes for `entries`. */
function dynamicArray(entries: Array<[number, number]>): Buffer {
  const out = Buffer.alloc(entries.length * DYNAMIC_BYTES);
  entries.forEach(([tag, value], index) => {
    out.writeBigUInt64LE(BigInt(tag), index * DYNAMIC_BYTES);
    out.writeBigUInt64LE(BigInt(value), index * DYNAMIC_BYTES + 8);
  });
  return out;
}

/** Where each part of a fixture goes: everything but the dynamic array is known before the layout. */
interface Plan {
  s: Required<ElfSpec>;
  base: number;
  interp: Buffer;
  strtab: Buffer;
  verneed: Buffer;
  entries: Array<[number, number]>;
  /** `extraDynamic` with each string replaced by its index. */
  extra: Array<[number, number]>;
  programHeaderCount: number;
}

function plan(spec: ElfSpec): Plan {
  const s = { ...DEFAULTS, ...spec };
  const strings = stringTable();
  const entries = namedEntries(s, strings);
  const verneed = versionNeeds(s.versionNeeds, strings);
  const extra = s.extraDynamic.map(([tag, value]): [number, number] => [
    tag,
    typeof value === "string" ? strings.add(value) : value,
  ]);
  const interp = s.interpreter === null ? Buffer.alloc(0) : Buffer.from(`${s.interpreter}\0`, "latin1");
  const programHeaderCount =
    1 + Number(s.programHeaderSegment !== null) + Number(interp.length > 0) + Number(s.dynamic) + s.extraLoads.length;
  const base = s.type === ElfType.Executable ? EXEC_BASE : 0;
  return { s, base, interp, strtab: strings.bytes(), verneed, entries, extra, programHeaderCount };
}

/** How long the file must be to hold the main load, every extra load and a copy of the program headers. */
function fileLength(s: Required<ElfSpec>, loadEnd: number, programHeaderBytes: number): number {
  const loadsEnd = Math.max(loadEnd, ...s.extraLoads.map((load) => loadEnd + load.offsetPastEnd + load.filesz));
  return s.programHeadersPastLoads ? align8(loadsEnd) + programHeaderBytes : loadsEnd;
}

/** One ELF64 little-endian file as `spec` describes it, with its layout. */
export function writeElf(spec: ElfSpec = {}): ElfFixture {
  const { s, base, interp, strtab, verneed, entries, extra, programHeaderCount } = plan(spec);
  const programHeaderBytes = programHeaderCount * PROGRAM_HEADER_BYTES;
  const interpreterAt = HEADER_BYTES + programHeaderBytes;
  const strtabAt = interpreterAt + interp.length;
  const verneedAt = align8(strtabAt + strtab.length);
  const dynamicAt = align8(verneedAt + verneed.length);
  entries.push([ElfTag.StrTab, base + strtabAt], [ElfTag.StrSz, strtab.length]);
  if (verneed.length > 0) entries.push([ElfTag.VerNeed, base + verneedAt], [ElfTag.VerNeedNum, s.versionNeeds.length]);
  entries.push(...extra, [ElfTag.Null, 0]);
  const dynamic = s.dynamic ? dynamicArray(entries) : Buffer.alloc(0);
  const total = dynamicAt + dynamic.length;

  const bytes = Buffer.alloc(fileLength(s, total, programHeaderBytes));
  writeHeader(bytes, s, base + dynamicAt, programHeaderCount);
  const writeSegment = segmentWriter(bytes, base);
  const segment: ElfLayout["segment"] = { phdr: null, interp: null, load: 0, dynamic: null };
  if (s.programHeaderSegment !== null) {
    const vaddr = base + HEADER_BYTES + s.programHeaderSegment.vaddrDelta;
    segment.phdr = writeSegment(ElfSegment.ProgramHeaders, HEADER_BYTES, programHeaderBytes, vaddr);
  }
  if (interp.length > 0) segment.interp = writeSegment(ElfSegment.Interp, interpreterAt, interp.length);
  segment.load = writeSegment(ElfSegment.Load, 0, total);
  for (const load of s.extraLoads) {
    writeSegment(ElfSegment.Load, total + load.offsetPastEnd, load.filesz, base + total + load.vaddrPastEnd);
  }
  if (s.dynamic) segment.dynamic = writeSegment(ElfSegment.Dynamic, dynamicAt, dynamic.length);
  bytes.set(interp, interpreterAt);
  bytes.set(strtab, strtabAt);
  bytes.set(verneed, verneedAt);
  bytes.set(dynamic, dynamicAt);
  const programHeaders = s.programHeadersPastLoads ? bytes.length - programHeaderBytes : HEADER_BYTES;
  if (s.programHeadersPastLoads) {
    bytes.copy(bytes, programHeaders, HEADER_BYTES, HEADER_BYTES + programHeaderBytes);
    bytes.writeBigUInt64LE(BigInt(programHeaders), ELF_HEADER.ProgramHeaderOffset);
  }
  const at = (part: Buffer, offset: number): number | null => (part.length > 0 ? offset : null);
  return {
    bytes,
    layout: {
      base,
      programHeaders,
      programHeaderCount,
      segment,
      interpreter: at(interp, interpreterAt),
      strtab: strtabAt,
      strsz: strtab.length,
      verneed: at(verneed, verneedAt),
      dynamic: at(dynamic, dynamicAt),
      dynamicEntries: s.dynamic ? entries : [],
    },
  };
}

/** The file offset of program header `index`'s field at `field`. */
export function programHeaderField(layout: ElfLayout, index: number, field: number): number {
  return layout.programHeaders + index * PROGRAM_HEADER_BYTES + field;
}

/** The file offset of the first dynamic entry with `tag` (its tag; the value is 8 bytes on). */
export function dynamicEntryOf(layout: ElfLayout, tag: number): number {
  const index = layout.dynamicEntries.findIndex(([entryTag]) => entryTag === tag);
  if (layout.dynamic === null || index < 0) throw new Error(`fixture has no dynamic entry ${tag}`);
  return layout.dynamic + index * DYNAMIC_BYTES;
}

/** The ELF64 file offsets of the dynamic array and string table, found the way the reader finds them. */
function dynamicView(bytes: Buffer): { dynamic: number; count: number; strtab: number } {
  const phoff = Number(bytes.readBigUInt64LE(ELF_HEADER.ProgramHeaderOffset));
  const headers = Array.from({ length: bytes.readUInt16LE(ELF_HEADER.ProgramHeaderCount) }, (_, index) => {
    const at = phoff + index * PROGRAM_HEADER_BYTES;
    return {
      type: bytes.readUInt32LE(at),
      offset: Number(bytes.readBigUInt64LE(at + ELF_PROGRAM_HEADER.Offset)),
      vaddr: Number(bytes.readBigUInt64LE(at + ELF_PROGRAM_HEADER.Vaddr)),
      filesz: Number(bytes.readBigUInt64LE(at + ELF_PROGRAM_HEADER.FileSize)),
    };
  });
  const dynamic = headers.find((header) => header.type === ElfSegment.Dynamic);
  if (!dynamic) throw new Error("no PT_DYNAMIC");
  const count = Math.floor(dynamic.filesz / DYNAMIC_BYTES);
  const tagAt = (index: number): bigint => bytes.readBigUInt64LE(dynamic.offset + index * DYNAMIC_BYTES);
  const strtabIndex = Array.from({ length: count }, (_, index) => index).find(
    (index) => tagAt(index) === BigInt(ElfTag.StrTab),
  );
  if (strtabIndex === undefined) throw new Error("no DT_STRTAB");
  const address = Number(bytes.readBigUInt64LE(dynamic.offset + strtabIndex * DYNAMIC_BYTES + 8));
  const load = headers.find(
    (header) => header.type === ElfSegment.Load && address >= header.vaddr && address < header.vaddr + header.filesz,
  );
  if (!load) throw new Error("DT_STRTAB is not loaded");
  return { dynamic: dynamic.offset, count, strtab: load.offset + (address - load.vaddr) };
}

/** A copy of a real ELF64 file with its `DT_NEEDED` entry for `name` retagged as `tag` (DT_FILTER, DT_AUXILIARY, …). */
export function retagNeeded(original: Uint8Array, name: string, tag: number): Buffer {
  const bytes = Buffer.from(original);
  const view = dynamicView(bytes);
  for (let index = 0; index < view.count; index++) {
    const at = view.dynamic + index * DYNAMIC_BYTES;
    if (bytes.readBigUInt64LE(at) !== BigInt(ElfTag.Needed)) continue;
    const start = view.strtab + Number(bytes.readBigUInt64LE(at + 8));
    if (bytes.toString("latin1", start, bytes.indexOf(0, start)) !== name) continue;
    bytes.writeBigUInt64LE(BigInt(tag), at);
    return bytes;
  }
  throw new Error(`no DT_NEEDED ${name}`);
}
