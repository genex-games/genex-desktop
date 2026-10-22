/**
 * Minimal Windows PE images for the package's Visual C++ runtime checks
 * (scripts/package-vc-runtime.cjs): the headers, one section, and an import table and a delay-load
 * table naming the DLLs a test gives. Nothing runs them; they are read only.
 */

/** PE machine types an image can claim. */
export const PeMachine = { X86: 0x14c, X64: 0x8664, Arm64: 0xaa64 } as const;
export type PeMachine = (typeof PeMachine)[keyof typeof PeMachine];

/** What a test image holds. */
export interface PeImageSpec {
  machine?: PeMachine;
  /** DLLs in the import table. */
  imports?: readonly string[];
  /** DLLs in the delay-load table. */
  delayed?: readonly string[];
  /** PE32 only: delay-load names as virtual addresses (attribute bit clear), as linkers before VC 7 wrote them. */
  delayedAsVa?: boolean;
  /** A 32-bit (PE32) image instead of PE32+. */
  pe32?: boolean;
}

const LFANEW = 0x40;
const COFF = LFANEW + 4;
const OPTIONAL = COFF + 20;
const DIRECTORY_COUNT = 16;
const SECTION_RVA = 0x1000;
const SECTION_FILE = 0x200;
const IMAGE_BASE_32 = 0x400000;
const IMAGE_BASE_64 = 0x140000000;
const IMPORT_DESCRIPTOR = 20;
const DELAY_DESCRIPTOR = 32;

/** Where the optional header's data directories start, for a test that rewrites one. */
export function dataDirectoryOffset(index: number, pe32 = false): number {
  return OPTIONAL + (pe32 ? 96 : 112) + index * 8;
}

/** The import table's data directory index in the PE/COFF specification. */
export const IMPORT_DIRECTORY = 1;

/** A PE image whose tables name `spec`'s DLLs. */
export function peImageBytes(spec: PeImageSpec = {}): Buffer {
  const { machine = PeMachine.X64, imports = [], delayed = [], delayedAsVa = false, pe32 = false } = spec;
  const imageBase = pe32 ? IMAGE_BASE_32 : IMAGE_BASE_64;
  const importTable = 0;
  const delayTable = imports.length ? (imports.length + 1) * IMPORT_DESCRIPTOR : 0;
  let nameAt = delayTable + (delayed.length ? (delayed.length + 1) * DELAY_DESCRIPTOR : 0);
  const names = [...imports, ...delayed].map((name) => {
    const at = nameAt;
    nameAt += name.length + 1;
    return { name, at };
  });
  const section = Buffer.alloc(nameAt);
  imports.forEach((_, i) => {
    section.writeUInt32LE(SECTION_RVA + (names[i]?.at ?? 0), importTable + i * IMPORT_DESCRIPTOR + 12);
  });
  delayed.forEach((_, i) => {
    const descriptor = delayTable + i * DELAY_DESCRIPTOR;
    const rva = SECTION_RVA + (names[imports.length + i]?.at ?? 0);
    section.writeUInt32LE(delayedAsVa ? 0 : 1, descriptor);
    section.writeUInt32LE(delayedAsVa ? imageBase + rva : rva, descriptor + 4);
  });
  for (const { name, at } of names) section.write(name, at, "latin1");

  const optionalSize = (pe32 ? 96 : 112) + DIRECTORY_COUNT * 8;
  const headers = Buffer.alloc(SECTION_FILE);
  headers.writeUInt16LE(0x5a4d, 0);
  headers.writeUInt32LE(LFANEW, 0x3c);
  headers.writeUInt32LE(0x00004550, LFANEW);
  headers.writeUInt16LE(machine, COFF);
  headers.writeUInt16LE(1, COFF + 2);
  headers.writeUInt16LE(optionalSize, COFF + 16);
  headers.writeUInt16LE(pe32 ? 0x10b : 0x20b, OPTIONAL);
  if (pe32) headers.writeUInt32LE(imageBase, OPTIONAL + 28);
  else headers.writeBigUInt64LE(BigInt(imageBase), OPTIONAL + 24);
  headers.writeUInt32LE(DIRECTORY_COUNT, OPTIONAL + (pe32 ? 92 : 108));
  if (imports.length) headers.writeUInt32LE(SECTION_RVA + importTable, dataDirectoryOffset(IMPORT_DIRECTORY, pe32));
  if (delayed.length) headers.writeUInt32LE(SECTION_RVA + delayTable, dataDirectoryOffset(13, pe32));
  const sectionHeader = OPTIONAL + optionalSize;
  headers.write(".idata", sectionHeader, "latin1");
  headers.writeUInt32LE(section.length, sectionHeader + 8);
  headers.writeUInt32LE(SECTION_RVA, sectionHeader + 12);
  headers.writeUInt32LE(section.length, sectionHeader + 16);
  headers.writeUInt32LE(SECTION_FILE, sectionHeader + 20);
  return Buffer.concat([headers, section]);
}
