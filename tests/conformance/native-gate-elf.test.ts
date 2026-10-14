/**
 * The Linux bundle gate (`substrate/native-gate-elf.ts`, plan D17 = B, §8.7, M4b): the pure-TS
 * ELF64 reader returns what the loader would read and refuses every malformed or oversized file
 * with a typed reason (never another exception, never a hang), and admission takes an x86_64
 * game that imports the bundled ANGLE, has `RUNPATH=$ORIGIN` and needs glibc ≤ 2.28, and refuses
 * every other bundle with a typed refusal while writing nothing (and, for a linked folder, while
 * opening nothing). Real-file rows read the store's CI-built Linux ANGLE (cross-checked with the
 * facts CI recorded with readelf/objdump) and zig-built x86_64-linux-gnu executables, some patched
 * to load libGL through a filter or audit tag.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import {
  copyFile,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { ANDROID_LOAD_ALIGN_BYTES, NativeRefusal, RustAdmissionProblem } from "../../src/shared/native-contract.ts";
import {
  admitAndroidElf,
  admitLinuxBundle,
  admitRustLinuxElf,
  ElfError,
  ElfFileType,
  ElfGateReason,
  ElfLoadTag,
  highestGlibc,
  LINUX_ELF_MAX_BYTES,
  LINUX_HOST_FILES,
  type LinuxAdmission,
  linuxHostFiles,
  parseElf,
  readElf,
} from "../../src/substrate/native-gate-elf.ts";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import {
  dynamicEntryOf,
  ELF_HEADER,
  ELF_PROGRAM_HEADER,
  ElfMachine,
  ElfSegment,
  type ElfSpec,
  ElfTag,
  ElfType,
  programHeaderField,
  retagNeeded,
  writeElf,
} from "../helpers/elf.ts";
import { androidBinary, linuxBinary, M2 } from "../fixtures/rust-bundles/binaries.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const POSIX = process.platform !== "win32";
const ZIG_BUILD_TIMEOUT_MS = 240_000;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A synthetic host library: what the store's ANGLE looks like to the gate. */
const hostLibrary = (soname: string, glibc = "GLIBC_2.17"): Buffer =>
  writeElf({
    type: ElfType.Shared,
    interpreter: null,
    soname,
    needed: ["libc.so.6"],
    runpath: [],
    versionNeeds: [{ file: "libc.so.6", names: ["GLIBC_2.2.5", glibc] }],
  }).bytes;

const HOST: Record<string, Buffer> = {
  "libEGL.so": hostLibrary("libEGL.so"),
  "libGLESv2.so": hostLibrary("libGLESv2.so"),
  "vk_swiftshader_icd.json": Buffer.from('{"ICD":{"library_path":"./libvk_swiftshader.so"}}\n'),
};
const HOST_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(HOST).map(([name, bytes]) => [name, sha256(bytes)]),
);

const game = (spec: ElfSpec = {}): Buffer => writeElf(spec).bytes;

/** What a bundle entry is on disk. */
type Entry =
  | Buffer
  | { symlinkTo: string }
  | { hardLinkTo: string }
  | { fifo: true }
  | { dir: true }
  | { absent: true };

interface Rig {
  /** The row's whole tree: `bundle/` and `outside/`, snapshotted before and after. */
  parent: string;
  root: string;
  outside: string;
}

/** Writes `entries` under a fresh `bundle/` (links resolve against `outside/`). */
async function rig(entries: Record<string, Entry>): Promise<Rig> {
  const parent = await tmpDir("elf-gate-");
  const root = path.join(parent, "bundle");
  const outside = path.join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.so"), game());
  await mkdir(path.join(outside, "dir"));
  await writeFile(path.join(outside, "dir", "x.png"), "png");
  for (const [name, entry] of Object.entries(entries)) {
    const file = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    if (Buffer.isBuffer(entry)) await writeFile(file, entry);
    else if ("symlinkTo" in entry) await symlink(path.join(outside, entry.symlinkTo), file);
    else if ("hardLinkTo" in entry) await link(path.join(outside, entry.hardLinkTo), file);
    else if ("fifo" in entry) execFileSync("mkfifo", [file]);
    else if ("dir" in entry) await mkdir(file);
  }
  return { parent, root, outside };
}

/** Whether names differing only in case are two files here (Linux) or one (the Mac's default disk). */
async function caseSensitiveDisk(): Promise<boolean> {
  const dir = await tmpDir("elf-gate-case-");
  await writeFile(path.join(dir, "Case"), "");
  return lstat(path.join(dir, "case")).then(
    () => false,
    () => true,
  );
}
const CASE_SENSITIVE = await caseSensitiveDisk();

/** Every entry under `dir`, never following links: type, size, mode, mtime and content digest. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const name of (await readdir(at)).sort()) {
      const file = path.join(at, name);
      const info = await lstat(file);
      const digest = info.isFile() ? sha256(await readFile(file)) : "";
      out.push(`${path.relative(dir, file)} ${info.mode} ${info.size} ${info.mtimeMs} ${info.nlink} ${digest}`);
      if (info.isDirectory()) await walk(file);
    }
  };
  await walk(dir);
  return out;
}

const admit = (
  r: Rig,
  options: { exe?: string; hostFiles?: Record<string, string>; glibcFloor?: string } = {},
): Promise<LinuxAdmission> =>
  admitLinuxBundle({
    root: r.root,
    exe: options.exe ?? "game",
    hostFiles: options.hostFiles ?? HOST_FILES,
    ...(options.glibcFloor ? { glibcFloor: options.glibcFloor } : {}),
  });

function assertRefused(result: LinuxAdmission, refusal: NativeRefusal, reason: ElfGateReason): void {
  assert.equal(result.ok, false, `expected ${reason}, got admitted`);
  if (result.ok) return;
  assert.deepEqual({ refusal: result.refusal, reason: result.reason }, { refusal, reason }, result.detail);
}

const setByte = (bytes: Buffer, at: number, value: number): undefined => {
  bytes[at] = value;
  return undefined;
};

/** A valid game with one change to its bytes. */
function mutated(change: (bytes: Buffer, layout: ReturnType<typeof writeElf>["layout"]) => Buffer | undefined): Buffer {
  const { bytes, layout } = writeElf();
  return change(bytes, layout) ?? bytes;
}

function assertElfError(bytes: Uint8Array, reason: ElfGateReason): void {
  assert.throws(
    () => parseElf(bytes),
    (error: unknown) => error instanceof ElfError && error.reason === reason,
    `expected ElfError ${reason}`,
  );
}

const HOSTILE: Array<{ name: string; bytes: () => Uint8Array; reason: ElfGateReason }> = [
  { name: "empty", bytes: () => Buffer.alloc(0), reason: ElfGateReason.NotElf },
  { name: "a shell script", bytes: () => Buffer.from("#!/bin/sh\necho hi\n"), reason: ElfGateReason.NotElf },
  { name: "three magic bytes", bytes: () => Buffer.from([0x7f, 0x45, 0x4c]), reason: ElfGateReason.NotElf },
  { name: "header cut at 40 bytes", bytes: () => game().subarray(0, 40), reason: ElfGateReason.Truncated },
  {
    name: "32-bit class",
    bytes: () => mutated((b) => setByte(b, ELF_HEADER.Class, 1)),
    reason: ElfGateReason.Not64Bit,
  },
  {
    name: "big-endian",
    bytes: () => mutated((b) => setByte(b, ELF_HEADER.Data, 2)),
    reason: ElfGateReason.NotLittleEndian,
  },
  {
    name: "ident version 0",
    bytes: () => mutated((b) => setByte(b, ELF_HEADER.Version, 0)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "program header size 32",
    bytes: () => mutated((b) => void b.writeUInt16LE(32, ELF_HEADER.ProgramHeaderSize)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "no program headers",
    bytes: () => mutated((b) => void b.writeUInt16LE(0, ELF_HEADER.ProgramHeaderCount)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "65535 program headers (PN_XNUM)",
    bytes: () => mutated((b) => void b.writeUInt16LE(0xffff, ELF_HEADER.ProgramHeaderCount)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "program headers past the end",
    bytes: () => mutated((b) => void b.writeBigUInt64LE(0xfffffn, ELF_HEADER.ProgramHeaderOffset)),
    reason: ElfGateReason.Truncated,
  },
  {
    name: "an offset beyond 2^53",
    bytes: () => mutated((b) => void b.writeBigUInt64LE(1n << 63n, ELF_HEADER.ProgramHeaderOffset)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a loaded segment past the end of the file",
    bytes: () =>
      mutated(
        (b, l) => void b.writeBigUInt64LE(0xfffffn, programHeaderField(l, l.segment.load, ELF_PROGRAM_HEADER.FileSize)),
      ),
    reason: ElfGateReason.Truncated,
  },
  {
    name: "a loaded segment smaller in memory than on disk",
    bytes: () =>
      mutated(
        (b, l) => void b.writeBigUInt64LE(16n, programHeaderField(l, l.segment.load, ELF_PROGRAM_HEADER.MemSize)),
      ),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a relocatable object",
    bytes: () => mutated((b) => void b.writeUInt16LE(ElfType.Relocatable, ELF_HEADER.Type)),
    reason: ElfGateReason.NotExecutable,
  },
  {
    name: "a core dump",
    bytes: () => mutated((b) => void b.writeUInt16LE(ElfType.Core, ELF_HEADER.Type)),
    reason: ElfGateReason.NotExecutable,
  },
  {
    name: "an interpreter without its NUL",
    bytes: () =>
      mutated((b, l) => {
        const at = (l.interpreter ?? 0) + "/lib64/ld-linux-x86-64.so.2".length;
        b[at] = 0x78;
        return undefined;
      }),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "two interpreters",
    bytes: () =>
      mutated(
        (b, l) =>
          void b.writeUInt32LE(
            ElfSegment.Interp,
            programHeaderField(l, l.segment.dynamic ?? 0, ELF_PROGRAM_HEADER.Type),
          ),
      ),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a dynamic segment outside every loaded segment",
    bytes: () =>
      mutated(
        (b, l) =>
          void b.writeBigUInt64LE(0x10000000n, programHeaderField(l, l.segment.dynamic ?? 0, ELF_PROGRAM_HEADER.Vaddr)),
      ),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a dynamic segment whose file offset is not where its address maps",
    bytes: () =>
      mutated(
        (b, l) => void b.writeBigUInt64LE(0n, programHeaderField(l, l.segment.dynamic ?? 0, ELF_PROGRAM_HEADER.Offset)),
      ),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a dynamic array without DT_NULL",
    bytes: () => mutated((b, l) => void b.writeBigUInt64LE(0x70000000n, dynamicEntryOf(l, ElfTag.Null))),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "5000 dynamic entries",
    bytes: () => game({ extraDynamic: Array.from({ length: 5000 }, () => [0x60000000, 0] as [number, number]) }),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a string table outside every loaded segment",
    bytes: () => mutated((b, l) => void b.writeBigUInt64LE(0x90000000n, dynamicEntryOf(l, ElfTag.StrTab) + 8)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a string table larger than the file",
    bytes: () => mutated((b, l) => void b.writeBigUInt64LE(0x7fffffffn, dynamicEntryOf(l, ElfTag.StrSz) + 8)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a needed name past the string table",
    bytes: () => mutated((b, l) => void b.writeBigUInt64LE(BigInt(l.strsz + 4), dynamicEntryOf(l, ElfTag.Needed) + 8)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a string whose NUL lies past the table's size",
    bytes: () => mutated((b, l) => void b.writeBigUInt64LE(BigInt(l.strsz - 1), dynamicEntryOf(l, ElfTag.StrSz) + 8)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "two string tables",
    bytes: () => game({ extraDynamic: [[ElfTag.StrTab, 0x400000]] }),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a version count without version needs",
    bytes: () => game({ versionNeeds: [], extraDynamic: [[ElfTag.VerNeedNum, 2]] }),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a version need of version 2",
    bytes: () => mutated((b, l) => void b.writeUInt16LE(2, l.verneed ?? 0)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a version need that counts more names than it chains",
    bytes: () => mutated((b, l) => void b.writeUInt16LE(5, (l.verneed ?? 0) + 2)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a version need with no names",
    bytes: () => mutated((b, l) => void b.writeUInt16LE(0, (l.verneed ?? 0) + 2)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a version need chain longer than DT_VERNEEDNUM",
    bytes: () => mutated((b, l) => void b.writeBigUInt64LE(1n, dynamicEntryOf(l, ElfTag.VerNeedNum) + 8)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a version need whose next entry is outside the file",
    bytes: () => mutated((b, l) => void b.writeUInt32LE(0x7fffffff, (l.verneed ?? 0) + 12)),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a DT_FILTER name past the string table",
    bytes: () => game({ extraDynamic: [[ElfTag.Filter, 0x7fffffff]] }),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a load that shares a page with the one before but maps it from other file bytes",
    bytes: () => game({ extraLoads: [{ vaddrPastEnd: 0, offsetPastEnd: 4096, filesz: 16 }] }),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a load whose address and offset differ within a page",
    bytes: () => game({ extraLoads: [{ vaddrPastEnd: 0x10010, offsetPastEnd: 0, filesz: 16 }] }),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a load aligned to less than a page",
    bytes: () =>
      mutated((b, l) => void b.writeBigUInt64LE(16n, programHeaderField(l, l.segment.load, ELF_PROGRAM_HEADER.Align))),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a load whose alignment is not a power of two",
    bytes: () =>
      mutated(
        (b, l) => void b.writeBigUInt64LE(0x1800n, programHeaderField(l, l.segment.load, ELF_PROGRAM_HEADER.Align)),
      ),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "program headers outside every loaded segment",
    bytes: () => game({ programHeadersPastLoads: true }),
    reason: ElfGateReason.Malformed,
  },
  {
    name: "a PT_PHDR that is not where the program headers load",
    bytes: () => game({ programHeaderSegment: { vaddrDelta: 0x100 } }),
    reason: ElfGateReason.Malformed,
  },
];

describe("ELF reader", () => {
  it("reads what the dynamic loader reads: type, machine, interpreter, needs, paths and glibc versions", () => {
    const image = parseElf(
      game({
        needed: ["libGLESv2.so", "libc.so.6"],
        runpath: ["$ORIGIN"],
        rpath: ["/opt/x"],
        soname: "game",
        versionNeeds: [
          { file: "libc.so.6", names: ["GLIBC_2.2.5", "GLIBC_2.28"] },
          { file: "libm.so.6", names: ["GLIBC_2.27"] },
        ],
      }),
    );
    assert.deepEqual(image, {
      fileType: ElfFileType.Executable,
      machine: ElfMachine.X64,
      interpreter: "/lib64/ld-linux-x86-64.so.2",
      soname: "game",
      needed: ["libGLESv2.so", "libc.so.6"],
      runpath: ["$ORIGIN"],
      rpath: ["/opt/x"],
      versionNeeds: [
        { file: "libc.so.6", names: ["GLIBC_2.2.5", "GLIBC_2.28"] },
        { file: "libm.so.6", names: ["GLIBC_2.27"] },
      ],
      tagLoads: [],
      dynamicTags: [
        ElfTag.Needed,
        ElfTag.SoName,
        ElfTag.RPath,
        ElfTag.RunPath,
        ElfTag.StrTab,
        ElfTag.StrSz,
        ElfTag.VerNeed,
        ElfTag.VerNeedNum,
      ],
      loadAlignments: [4096],
    });
    assert.equal(highestGlibc(image), "2.28");
  });

  it("reads the libraries filter and audit tags name, which glibc loads besides DT_NEEDED", () => {
    const image = parseElf(
      game({
        extraDynamic: [
          [ElfTag.Auxiliary, "libGL.so.1"],
          [ElfTag.Filter, "libfilter.so"],
          [ElfTag.Audit, "libaudit.so"],
          [ElfTag.DepAudit, "libdepaudit.so"],
        ],
      }),
    );
    assert.deepEqual(image.tagLoads, [
      { tag: ElfLoadTag.Auxiliary, name: "libGL.so.1" },
      { tag: ElfLoadTag.Filter, name: "libfilter.so" },
      { tag: ElfLoadTag.Audit, name: "libaudit.so" },
      { tag: ElfLoadTag.DepAudit, name: "libdepaudit.so" },
    ]);
  });

  it("accepts the layouts linkers write: PT_PHDR, a load on its own page, a load sharing a page at the same offset", () => {
    for (const spec of [
      { programHeaderSegment: { vaddrDelta: 0 } },
      { extraLoads: [{ vaddrPastEnd: 0x10000, offsetPastEnd: 0, filesz: 16 }] },
      { extraLoads: [{ vaddrPastEnd: 0, offsetPastEnd: 0, filesz: 16 }] },
    ]) {
      assert.deepEqual(parseElf(game(spec)).needed, ["libGLESv2.so", "libm.so.6", "libc.so.6"], JSON.stringify(spec));
    }
  });

  it("orders glibc versions numerically, not as text (2.3 < 2.17 < 2.28)", () => {
    const image = parseElf(game({ versionNeeds: [{ file: "libc.so.6", names: ["GLIBC_2.17", "GLIBC_2.3"] }] }));
    assert.equal(highestGlibc(image), "2.17");
    assert.equal(highestGlibc(parseElf(game({ versionNeeds: [] }))), null);
  });

  it("tells a PIE executable (ET_DYN with an interpreter) from a shared object", () => {
    assert.equal(parseElf(game({ type: ElfType.Shared })).fileType, ElfFileType.Executable);
    assert.equal(parseElf(HOST["libEGL.so"] as Buffer).fileType, ElfFileType.SharedObject);
  });

  for (const row of HOSTILE) {
    it(`refuses ${row.name} with a typed reason`, () => assertElfError(row.bytes(), row.reason));
  }

  it("answers 3000 random corruptions with an image or an ElfError, nothing else", () => {
    let seed = 0x2b3ee1e2;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const original = game();
    for (let round = 0; round < 3000; round++) {
      const bytes = Buffer.from(original);
      const flips = 1 + Math.floor(random() * 8);
      for (let n = 0; n < flips; n++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      const cut = random() < 0.2 ? Math.floor(random() * bytes.length) : bytes.length;
      try {
        parseElf(bytes.subarray(0, cut));
      } catch (error) {
        assert.ok(error instanceof ElfError, `round ${round}: ${String(error)}`);
      }
    }
  });
});

const ADMITTED: Array<{
  name: string;
  entries: () => Record<string, Entry>;
  glibcFloor?: string;
  hostCopies?: string[];
}> = [
  {
    name: "a game importing only libEGL.so",
    entries: () => ({ game: game({ needed: ["libEGL.so", "libc.so.6"] }) }),
  },
  { name: "a PIE game", entries: () => ({ game: game({ type: ElfType.Shared }) }) },
  {
    name: "a game needing every glibc library",
    entries: () => ({
      game: game({
        needed: [
          "libGLESv2.so",
          "libc.so.6",
          "libm.so.6",
          "libdl.so.2",
          "libpthread.so.0",
          "librt.so.1",
          "ld-linux-x86-64.so.2",
        ],
      }),
    }),
  },
  {
    name: "a game needing no library but ANGLE",
    entries: () => ({ game: game({ needed: ["libGLESv2.so"], versionNeeds: [] }) }),
  },
  {
    name: "a game with PT_PHDR and a second load on its own page",
    entries: () => ({
      game: game({
        programHeaderSegment: { vaddrDelta: 0 },
        extraLoads: [{ vaddrPastEnd: 0x10000, offsetPastEnd: 0, filesz: 16 }],
      }),
    }),
  },
  {
    name: "a game with every dynamic tag a linker writes",
    entries: () => ({
      game: game({
        extraDynamic: [
          ElfTag.PltRelSz,
          ElfTag.PltGot,
          ElfTag.SymTab,
          ElfTag.Rela,
          ElfTag.Debug,
          ElfTag.Flags,
          ElfTag.GnuHash,
          ElfTag.VerSym,
          ElfTag.Flags1,
        ].map((tag): [number, number] => [tag, 0]),
      }),
    }),
  },
  {
    name: "byte-identical copies of the host's files beside the game",
    entries: () => ({ game: game(), ...HOST }),
    hostCopies: ["libEGL.so", "libGLESv2.so", "vk_swiftshader_icd.json"],
  },
  {
    name: "a game for glibc 2.34 when the floor says 2.34",
    entries: () => ({ game: game({ versionNeeds: [{ file: "libc.so.6", names: ["GLIBC_2.34"] }] }) }),
    glibcFloor: "2.34",
  },
];

const REFUSED: Array<{
  name: string;
  entries: () => Record<string, Entry>;
  exe?: string;
  hostFiles?: Record<string, string>;
  refusal: NativeRefusal;
  reason: ElfGateReason;
  posixOnly?: boolean;
  caseSensitiveOnly?: boolean;
}> = [
  ...["libGL.so.1", "libGLX_mesa.so.0", "libOpenGL.so.0", "libEGL.so.1", "libGLESv2.so.2", "/usr/lib/libGL.so.1"].map(
    (lib) => ({
      name: `a game importing ${lib}`,
      entries: () => ({ game: game({ needed: ["libGLESv2.so", lib, "libc.so.6"] }) }),
      refusal: NativeRefusal.ImportsLibGl,
      reason: ElfGateReason.ImportsForeignGl,
    }),
  ),
  ...[ElfTag.Filter, ElfTag.Auxiliary, ElfTag.Audit, ElfTag.DepAudit].flatMap((tag) => [
    {
      name: `a game loading libGL.so.1 through dynamic tag 0x${tag.toString(16)}`,
      entries: () => ({ game: game({ extraDynamic: [[tag, "libGL.so.1"]] }) }),
      refusal: NativeRefusal.ImportsLibGl,
      reason: ElfGateReason.ImportsForeignGl,
    },
    {
      name: `a game loading libhook.so through dynamic tag 0x${tag.toString(16)}`,
      entries: () => ({ game: game({ extraDynamic: [[tag, "libhook.so"]] }) }),
      refusal: NativeRefusal.ExtraSharedObject,
      reason: ElfGateReason.LoadsLibraryByTag,
    },
  ]),
  ...[0x7ffffffe, 0x6ffffefa, 0x60000000, 2 ** 40].map((tag) => ({
    name: `a game with dynamic tag 0x${tag.toString(16)}, which no linker writes into a game`,
    entries: () => ({ game: game({ extraDynamic: [[tag, 0]] }) }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.UnknownDynamicTag,
  })),
  {
    name: "a game importing no ANGLE library",
    entries: () => ({ game: game({ needed: ["libm.so.6", "libc.so.6"] }) }),
    refusal: NativeRefusal.MissingAngleImport,
    reason: ElfGateReason.MissingAngleImport,
  },
  {
    name: "a game importing ANGLE by a path",
    entries: () => ({ game: game({ needed: ["./libGLESv2.so", "libc.so.6"] }) }),
    refusal: NativeRefusal.MissingAngleImport,
    reason: ElfGateReason.MissingAngleImport,
  },
  ...["libfoo.so.1", "libX11.so.6", "libstdc++.so.6", "libvulkan.so.1", "/tmp/evil.so"].map((lib) => ({
    name: `a game needing ${lib}`,
    entries: () => ({ game: game({ needed: ["libGLESv2.so", lib, "libc.so.6"] }) }),
    refusal: NativeRefusal.ForeignImport,
    reason: ElfGateReason.NeedsForeignLibrary,
  })),
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the brace spelling of $ORIGIN is the hostile input
  ...[[], ["$ORIGIN/lib"], ["${ORIGIN}"], ["$ORIGIN:/usr/lib"], ["/usr/lib"], ["$ORIGIN", "$ORIGIN"]].map(
    (runpath) => ({
      name: `a game with RUNPATH ${JSON.stringify(runpath)}`,
      entries: () => ({ game: game({ runpath }) }),
      refusal: NativeRefusal.RunpathNotOrigin,
      reason: ElfGateReason.RunpathNotOrigin,
    }),
  ),
  {
    name: "a game with DT_RPATH $ORIGIN (old tags)",
    entries: () => ({ game: game({ runpath: [], rpath: ["$ORIGIN"] }) }),
    refusal: NativeRefusal.RunpathNotOrigin,
    reason: ElfGateReason.HasRpath,
  },
  {
    name: "a game with both DT_RPATH and DT_RUNPATH",
    entries: () => ({ game: game({ rpath: ["$ORIGIN"] }) }),
    refusal: NativeRefusal.RunpathNotOrigin,
    reason: ElfGateReason.HasRpath,
  },
  ...[
    { file: "libc.so.6", version: "GLIBC_2.29" },
    { file: "libc.so.6", version: "GLIBC_2.34" },
    { file: "libm.so.6", version: "GLIBC_2.38" },
    { file: "libc.so.6", version: "GLIBC_3.0" },
  ].map(({ file, version }) => ({
    name: `a game needing ${version} from ${file}`,
    entries: () => ({ game: game({ versionNeeds: [{ file, names: ["GLIBC_2.2.5", version] }] }) }),
    refusal: NativeRefusal.GlibcTooNew,
    reason: ElfGateReason.GlibcTooNew,
  })),
  {
    name: "a game needing libc.so.6 without any GLIBC_ version",
    entries: () => ({ game: game({ needed: ["libGLESv2.so", "libc.so.6"], versionNeeds: [] }) }),
    refusal: NativeRefusal.GlibcTooNew,
    reason: ElfGateReason.GlibcUnversioned,
  },
  ...["GLIBC_PRIVATE", "GLIBC_ABI_DT_RELR", "GLIBC_2", "GLIBC_2.28.1.2.3"].map((version) => ({
    name: `a game needing ${version}`,
    entries: () => ({ game: game({ versionNeeds: [{ file: "libc.so.6", names: [version] }] }) }),
    refusal: NativeRefusal.GlibcTooNew,
    reason: ElfGateReason.GlibcUnknownVersion,
  })),
  ...[ElfMachine.Aarch64, ElfMachine.X86].map((machine) => ({
    name: `a game for machine ${machine}`,
    entries: () => ({ game: game({ machine }) }),
    refusal: NativeRefusal.WrongMachine,
    reason: ElfGateReason.WrongMachine,
  })),
  {
    name: "a shared object as the game",
    entries: () => ({ game: HOST["libGLESv2.so"] as Buffer }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.NotExecutable,
  },
  {
    name: "a statically linked game",
    entries: () => ({ game: game({ interpreter: null, dynamic: false }) }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.WrongInterpreter,
  },
  {
    name: "a game started through /tmp/ld.so",
    entries: () => ({ game: game({ interpreter: "/tmp/ld.so" }) }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.WrongInterpreter,
  },
  {
    name: "a shell script as the game",
    entries: () => ({ game: Buffer.from("#!/bin/sh\n") }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.NotElf,
  },
  {
    name: "a truncated game",
    entries: () => ({ game: game().subarray(0, 100) }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.Truncated,
  },
  {
    name: "its own libGLESv2.so",
    entries: () => ({ game: game(), "libGLESv2.so": hostLibrary("libGLESv2.so", "GLIBC_2.16") }),
    refusal: NativeRefusal.ExtraSharedObject,
    reason: ElfGateReason.HostFileDiffers,
  },
  {
    name: "its own Vulkan ICD file",
    entries: () => ({ game: game(), "vk_swiftshader_icd.json": Buffer.from('{"ICD":{"library_path":"/tmp/x.so"}}') }),
    refusal: NativeRefusal.ExtraSharedObject,
    reason: ElfGateReason.HostFileDiffers,
  },
  ...["libfoo.so", "libfoo.so.1.2", "assets/libGLESv2.so", "LIBGLESV2.SO", "VK_SWIFTSHADER_ICD.json", "x.SO"].map(
    (name) => ({
      name: `an extra ${name}`,
      entries: () => ({ game: game(), [name]: HOST["libGLESv2.so"] as Buffer }),
      refusal: NativeRefusal.ExtraSharedObject,
      reason: ElfGateReason.ExtraSharedObject,
    }),
  ),
  {
    name: "an ELF hidden as an asset",
    entries: () => ({ game: game(), "assets/data.bin": HOST["libEGL.so"] as Buffer }),
    refusal: NativeRefusal.ExtraSharedObject,
    reason: ElfGateReason.ExtraElf,
  },
  {
    name: "a second executable",
    entries: () => ({ game: game(), tool: game() }),
    refusal: NativeRefusal.ExtraSharedObject,
    reason: ElfGateReason.ExtraElf,
  },
  {
    name: "a byte-identical host library that needs glibc 2.34",
    entries: () => ({ game: game(), "libEGL.so": hostLibrary("libEGL.so", "GLIBC_2.34") }),
    hostFiles: { ...HOST_FILES, "libEGL.so": sha256(hostLibrary("libEGL.so", "GLIBC_2.34")) },
    refusal: NativeRefusal.GlibcTooNew,
    reason: ElfGateReason.GlibcTooNew,
  },
  {
    name: "a game that is a symlink",
    entries: () => ({ game: { symlinkTo: "secret.so" } }),
    refusal: NativeRefusal.Symlink,
    reason: ElfGateReason.Symlink,
    posixOnly: true,
  },
  {
    name: "an asset that is a symlink",
    entries: () => ({ game: game(), "assets/a.png": { symlinkTo: "dir/x.png" } }),
    refusal: NativeRefusal.Symlink,
    reason: ElfGateReason.Symlink,
    posixOnly: true,
  },
  {
    name: "a dangling symlink",
    entries: () => ({ game: game(), "assets/a.png": { symlinkTo: "nowhere" } }),
    refusal: NativeRefusal.Symlink,
    reason: ElfGateReason.Symlink,
    posixOnly: true,
  },
  {
    name: "a linked folder",
    entries: () => ({ game: game(), assets: { symlinkTo: "dir" } }),
    refusal: NativeRefusal.Symlink,
    reason: ElfGateReason.Symlink,
    posixOnly: true,
  },
  {
    name: "a link to a system GL beside the game",
    entries: () => ({ game: game(), "libGL.so.1": { symlinkTo: "secret.so" } }),
    refusal: NativeRefusal.Symlink,
    reason: ElfGateReason.Symlink,
    posixOnly: true,
  },
  {
    name: "a game that is a hard link",
    entries: () => ({ game: { hardLinkTo: "secret.so" } }),
    refusal: NativeRefusal.HardLink,
    reason: ElfGateReason.HardLink,
  },
  {
    name: "an asset that is a hard link",
    entries: () => ({ game: game(), "assets/a.png": { hardLinkTo: "dir/x.png" } }),
    refusal: NativeRefusal.HardLink,
    reason: ElfGateReason.HardLink,
  },
  {
    name: "a FIFO (read without blocking)",
    entries: () => ({ game: game(), "assets/pipe": { fifo: true } }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.NotRegular,
    posixOnly: true,
  },
  {
    name: "a game that is a folder",
    entries: () => ({ game: { dir: true } }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.ExeMissing,
  },
  {
    name: "a game named in another case than the file",
    entries: () => ({ game: game() }),
    exe: "Game",
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.ExeMissing,
  },
  ...["../game", "/etc/passwd", "a//b", "a/./b", "a/../game", "", ".", "a\\b", "x\0y", "game/", "bin/game"].map(
    (bad) => ({
      name: `a game named ${JSON.stringify(bad)}`,
      entries: () => ({ game: game(), "bin/game": game() }),
      exe: bad,
      refusal: NativeRefusal.NotAnExecutable,
      reason: ElfGateReason.BadName,
    }),
  ),
  ...["libEGL.so", "LIBGLESV2.SO", "libvulkan.so.1", "vk_swiftshader_icd.json", "game.so", "game.so.1"].map((exe) => ({
    name: `a game named ${exe}, a host file's or a shared object's name`,
    entries: () => ({ [exe]: game() }),
    exe,
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.BadName,
  })),
  {
    name: "a file whose name has a backslash",
    entries: () => ({ game: game(), "a\\b": Buffer.from("x") }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.BadName,
    posixOnly: true,
  },
  {
    name: "two files whose names differ only in case",
    entries: () => ({ game: game(), "Data.bin": Buffer.from("a"), "data.bin": Buffer.from("b") }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.BadName,
    caseSensitiveOnly: true,
  },
  {
    name: `files more than 32 folders deep`,
    entries: () => ({ game: game(), [`${"d/".repeat(32)}x.png`]: Buffer.from("png") }),
    refusal: NativeRefusal.NotAnExecutable,
    reason: ElfGateReason.TooManyFiles,
  },
];

describe("Linux bundle admission", () => {
  it("admits an x86_64 game for glibc 2.28 that imports the bundled ANGLE and runs from $ORIGIN", async () => {
    const r = await rig({
      game: game(),
      "assets/level.png": Buffer.from("png"),
      "assets/music/a.ogg": Buffer.from("ogg"),
    });
    const result = await admit(r);
    assert.ok(result.ok, result.ok ? "" : result.detail);
    assert.equal(result.bundle.exe, "game");
    assert.equal(result.bundle.exePath, path.join(r.root, "game"));
    assert.equal(result.bundle.exeSha256, sha256(game()));
    assert.equal(result.bundle.maxGlibc, "2.28");
    assert.deepEqual(result.bundle.files, ["assets/level.png", "assets/music/a.ogg", "game"]);
    assert.deepEqual(result.bundle.hostCopies, []);
  });

  for (const row of ADMITTED) {
    it(`admits ${row.name}`, async () => {
      const r = await rig(row.entries());
      const result = await admit(r, row.glibcFloor ? { glibcFloor: row.glibcFloor } : {});
      assert.ok(result.ok, result.ok ? "" : `${result.reason}: ${result.detail}`);
      assert.deepEqual(result.bundle.hostCopies, row.hostCopies ?? []);
    });
  }

  for (const row of REFUSED) {
    const posixSkip = row.posixOnly && !POSIX ? "not run: POSIX links, FIFOs and names" : undefined;
    const caseSkip = row.caseSensitiveOnly && !CASE_SENSITIVE ? "not run: this disk ignores case" : undefined;
    it(`refuses ${row.name}, writing nothing`, { skip: posixSkip ?? caseSkip }, async () => {
      const r = await rig(row.entries());
      const before = await snapshot(r.parent);
      const result = await admit(r, {
        ...(row.exe !== undefined ? { exe: row.exe } : {}),
        ...(row.hostFiles ? { hostFiles: row.hostFiles } : {}),
      });
      assertRefused(result, row.refusal, row.reason);
      assert.deepEqual(await snapshot(r.parent), before);
    });
  }

  it("refuses a FIFO under a linked folder as a link without opening it", { skip: !POSIX }, async () => {
    const r = await rig({ game: game() });
    const fifos = path.join(r.outside, "fifos");
    await mkdir(fifos);
    const pipe = path.join(fifos, "pipe");
    execFileSync("mkfifo", [pipe]);
    await symlink(fifos, path.join(r.root, "assets"));
    let writerOpened = false;
    // A writer's open blocks until some reader opens the FIFO: it completes only if the gate opens it.
    const writer = open(pipe, "w").then((handle) => {
      writerOpened = true;
      return handle;
    });
    let reader: FileHandle | undefined;
    try {
      assertRefused(await admit(r), NativeRefusal.Symlink, ElfGateReason.Symlink);
      assert.equal(writerOpened, false, "the gate opened the FIFO behind the linked folder");
    } finally {
      reader = await open(pipe, FS.O_RDONLY | FS.O_NONBLOCK);
      await (await writer).close();
      await reader.close();
    }
  });

  it("refuses a game over the size cap from its size alone", async () => {
    const r = await rig({ game: game() });
    await truncate(path.join(r.root, "game"), LINUX_ELF_MAX_BYTES + 1);
    assertRefused(await admit(r), NativeRefusal.NotAnExecutable, ElfGateReason.TooLarge);
  });

  it("throws on a malformed request: a host file outside the root, a bad digest, a bad floor", async () => {
    const r = await rig({ game: game() });
    await assert.rejects(admit(r, { hostFiles: { "lib/libEGL.so": "0".repeat(64) } }), TypeError);
    await assert.rejects(admit(r, { hostFiles: { "libEGL.so": "nope" } }), TypeError);
    await assert.rejects(admit(r, { glibcFloor: "2.x" }), TypeError);
  });

  it("reads the host lock from an ANGLE manifest and refuses one missing a host file", () => {
    const files = Object.fromEntries(LINUX_HOST_FILES.map((name) => [name, { sha256: "a".repeat(64), size: 1 }]));
    assert.deepEqual(
      linuxHostFiles({ files }),
      Object.fromEntries(LINUX_HOST_FILES.map((name) => [name, "a".repeat(64)])),
    );
    const { "libGLESv2.so": _dropped, ...partial } = files;
    assert.throws(() => linuxHostFiles({ files: partial }), TypeError);
    assert.throws(() => linuxHostFiles(null), TypeError);
  });
});

describe("Linux bundle admission through the shared walk", () => {
  it("refuses names one only by case or Unicode form on any disk, listed through the shared walk's reads", async () => {
    for (const twins of [
      ["Data.bin", "data.bin"],
      ["caf\u00e9.png", "cafe\u0301.png"],
    ]) {
      const r = await rig({ game: game(), [twins[0] ?? ""]: Buffer.from("a") });
      const before = await snapshot(r.parent);
      const reads = {
        lstat,
        opendir: async (dir: string) => {
          if (dir !== r.root) return opendir(dir);
          const names = ["game", ...twins];
          return { read: async () => (names.length > 0 ? { name: names.shift() ?? "" } : null), close: async () => {} };
        },
      };
      const result = await admitLinuxBundle({ root: r.root, exe: "game", hostFiles: HOST_FILES, reads });
      assertRefused(result, NativeRefusal.NotAnExecutable, ElfGateReason.BadName);
      assert.deepEqual(await snapshot(r.parent), before);
    }
  });

  it("refuses a missing or linked bundle folder instead of throwing", async () => {
    const r = await rig({ game: game() });
    const missing = await admitLinuxBundle({
      root: path.join(r.parent, "nowhere"),
      exe: "game",
      hostFiles: HOST_FILES,
    });
    assertRefused(missing, NativeRefusal.NotAnExecutable, ElfGateReason.NotRegular);
    if (!POSIX) return;
    const alias = path.join(r.parent, "alias");
    await symlink(r.root, alias);
    const linked = await admitLinuxBundle({ root: alias, exe: "game", hostFiles: HOST_FILES });
    assertRefused(linked, NativeRefusal.Symlink, ElfGateReason.Symlink);
  });
});

/** Sources for the zig rows: link stubs for ANGLE and for a system libGL, and a game using pthreads (GLIBC_2.34 when built for 2.34). */
const ZIG_SOURCES = {
  "stub.c": "void glClear(unsigned int mask) { (void)mask; }\n",
  "gl.c": "void glFlush(void) {}\n",
  "game.c": [
    "#include <pthread.h>",
    "void glClear(unsigned int mask);",
    "void glFlush(void);",
    "static void *work(void *arg) { return arg; }",
    "int main(void) {",
    "  pthread_t t; pthread_create(&t, 0, work, 0); pthread_join(t, 0); glClear(0x4000);",
    "#ifdef WITH_GL",
    "  glFlush();",
    "#endif",
    "  return 0;",
    "}",
    "",
  ].join("\n"),
} as const;

const ZIG_ORIGIN = "-Wl,-rpath,$ORIGIN";
const X64_228 = ["-target", "x86_64-linux-gnu.2.28"];

/** Each zig-built game's `zig cc` arguments after the stubs exist. */
const ZIG_GAMES = {
  ok: [...X64_228, "-o", "ok", "game.c", "-Llib-x64", "-lGLESv2", ZIG_ORIGIN],
  glibc234: ["-target", "x86_64-linux-gnu.2.34", "-o", "glibc234", "game.c", "-Llib-x64", "-lGLESv2", ZIG_ORIGIN],
  norpath: [...X64_228, "-o", "norpath", "game.c", "-Llib-x64", "-lGLESv2"],
  libgl: [...X64_228, "-o", "libgl", "-DWITH_GL", "game.c", "-Llib-x64", "-lGLESv2", "-Llib-gl", "-lGL", ZIG_ORIGIN],
  arm: ["-target", "aarch64-linux-gnu.2.28", "-o", "arm", "game.c", "-Llib-arm", "-lGLESv2", ZIG_ORIGIN],
} as const;
type ZigGame = keyof typeof ZIG_GAMES;

/** Builds the stubs, then every game in `ZIG_GAMES`, with caches of their own (never the user's zig cache). */
async function buildZigGames(zig: string): Promise<string> {
  const dir = await tmpDir("elf-gate-zig-");
  const env = {
    ...process.env,
    ZIG_GLOBAL_CACHE_DIR: path.join(dir, "zig-global"),
    ZIG_LOCAL_CACHE_DIR: path.join(dir, "zig-local"),
  };
  for (const [name, text] of Object.entries(ZIG_SOURCES)) await writeFile(path.join(dir, name), text);
  for (const folder of ["lib-x64", "lib-gl", "lib-arm"]) await mkdir(path.join(dir, folder));
  const cc = (args: readonly string[]) =>
    execFileAsync(zig, ["cc", ...args], { cwd: dir, env }).catch((error: { stderr?: string }) => {
      throw new Error(`zig cc ${args.join(" ")}: ${error.stderr ?? String(error)}`);
    });
  const stub = (target: string, out: string, soname: string, source = "stub.c") =>
    cc(["-target", target, "-shared", "-fPIC", `-Wl,-soname,${soname}`, "-o", out, source]);
  await Promise.all([
    stub("x86_64-linux-gnu.2.28", "lib-x64/libGLESv2.so", "libGLESv2.so"),
    stub("x86_64-linux-gnu.2.28", "lib-gl/libGL.so", "libGL.so.1", "gl.c"),
    stub("aarch64-linux-gnu.2.28", "lib-arm/libGLESv2.so", "libGLESv2.so"),
  ]);
  await Promise.all(Object.values(ZIG_GAMES).map((args) => cc(args)));
  return dir;
}

describe("real files", () => {
  const ANGLE_LIBRARIES = ["libEGL.so", "libGLESv2.so", "libvulkan.so.1", "libvk_swiftshader.so"] as const;

  it("reads the store's Linux ANGLE as CI recorded it with readelf and objdump", needsTools("angleLinux"), async () => {
    const found = devTool("angleLinux");
    assert.ok("path" in found);
    const manifest = JSON.parse(await readFile(path.join(found.path, "manifest.json"), "utf8")) as {
      facts: Record<string, { needed: string[]; runpath: string[]; maxGlibc: string }>;
    };
    for (const name of ANGLE_LIBRARIES) {
      const image = await readElf(path.join(found.path, name));
      const facts = manifest.facts[name];
      assert.ok(facts, name);
      assert.equal(image.fileType, ElfFileType.SharedObject, name);
      assert.equal(image.machine, ElfMachine.X64, name);
      assert.deepEqual(image.needed, facts.needed, name);
      assert.deepEqual([...image.runpath, ...image.rpath], facts.runpath, name);
      assert.equal(highestGlibc(image), facts.maxGlibc, name);
    }
    assert.equal((await readElf(path.join(found.path, "libGLESv2.so"))).soname, "libGLESv2.so");
  });

  it(
    "admits a game beside the store's own ANGLE files and refuses one changed byte",
    needsTools("angleLinux"),
    async () => {
      const found = devTool("angleLinux");
      assert.ok("path" in found);
      const hostFiles = linuxHostFiles(JSON.parse(await readFile(path.join(found.path, "manifest.json"), "utf8")));
      const r = await rig({ game: game() });
      for (const name of LINUX_HOST_FILES) await copyFile(path.join(found.path, name), path.join(r.root, name));
      const admitted = await admit(r, { hostFiles });
      assert.ok(admitted.ok, admitted.ok ? "" : `${admitted.reason}: ${admitted.detail}`);
      assert.deepEqual([...admitted.bundle.hostCopies].sort(), [...LINUX_HOST_FILES].sort());

      const gles = path.join(r.root, "libGLESv2.so");
      const bytes = await readFile(gles);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
      await writeFile(gles, bytes);
      assertRefused(await admit(r, { hostFiles }), NativeRefusal.ExtraSharedObject, ElfGateReason.HostFileDiffers);
    },
  );

  it("gates zig-built x86_64-linux-gnu executables: 2.28 + $ORIGIN admitted; 2.34, no rpath, libGL (needed, filtered or audited) and aarch64 refused", {
    ...needsTools("zig"),
    timeout: ZIG_BUILD_TIMEOUT_MS,
  }, async () => {
    const found = devTool("zig");
    assert.ok("path" in found);
    const dir = await buildZigGames(found.path);
    const bytesOf = (exe: ZigGame): Promise<Buffer> => readFile(path.join(dir, exe));
    const gateBytes = async (bytes: Buffer): Promise<LinuxAdmission> => admit(await rig({ game: bytes }));
    const gate = async (exe: ZigGame): Promise<LinuxAdmission> => gateBytes(await bytesOf(exe));

    const ok = await gate("ok");
    assert.ok(ok.ok, ok.ok ? "" : `${ok.reason}: ${ok.detail}`);
    assert.deepEqual(ok.bundle.image.runpath, ["$ORIGIN"]);
    assert.equal(ok.bundle.maxGlibc, "2.28");
    assert.ok(ok.bundle.image.needed.includes("libGLESv2.so"));
    assert.deepEqual(ok.bundle.image.tagLoads, []);

    const too = await gate("glibc234");
    assertRefused(too, NativeRefusal.GlibcTooNew, ElfGateReason.GlibcTooNew);
    assert.ok(!too.ok && too.detail.includes("GLIBC_2.34"));
    assertRefused(await gate("norpath"), NativeRefusal.RunpathNotOrigin, ElfGateReason.RunpathNotOrigin);
    assertRefused(await gate("libgl"), NativeRefusal.ImportsLibGl, ElfGateReason.ImportsForeignGl);
    const libgl = await bytesOf("libgl");
    for (const tag of [ElfTag.Auxiliary, ElfTag.Filter, ElfTag.Audit, ElfTag.DepAudit]) {
      const patched = retagNeeded(libgl, "libGL.so.1", tag);
      assert.deepEqual(parseElf(patched).needed.includes("libGL.so.1"), false);
      assertRefused(await gateBytes(patched), NativeRefusal.ImportsLibGl, ElfGateReason.ImportsForeignGl);
    }
    assertRefused(await gate("arm"), NativeRefusal.WrongMachine, ElfGateReason.WrongMachine);
  });
});

describe("Rust · wgpu ELF admission for Linux and Android (M3.5)", () => {
  type Admit = (
    bytes: Uint8Array,
  ) => { ok: true } | { ok: false; refusal: NativeRefusal; problem: RustAdmissionProblem };
  const verdict = (admit: Admit, bytes: Uint8Array) => {
    const admission = admit(bytes);
    return admission.ok ? "admitted" : `${admission.refusal}/${admission.problem}`;
  };
  const linux = (bytes: Uint8Array) => verdict(admitRustLinuxElf, bytes);
  const android = (bytes: Uint8Array) => verdict(admitAndroidElf, bytes);
  const glibc = (version: string) => [
    ...M2.linux.versionNeeds.filter((need) => need.file !== "libc.so.6"),
    { file: "libc.so.6", names: ["GLIBC_2.2.5", version] },
  ];

  it("admits the Linux build M2 linked, with the runtime libraries and $ORIGIN allowed", () => {
    assert.equal(linux(linuxBinary()), "admitted");
    const runtime = ["libgcc_s.so.1", "libasound.so.2", "libudev.so.1"];
    assert.equal(linux(linuxBinary({ needed: [...M2.linux.needed, ...runtime], runpath: ["$ORIGIN"] })), "admitted");
    const admission = admitRustLinuxElf(linuxBinary());
    assert.ok(admission.ok);
    assert.equal(admission.maxGlibc, "2.28");
  });

  it("admits the Android builds M2 linked: the 16 KB shared object and the linker64 executable", () => {
    assert.equal(android(androidBinary()), "admitted");
    const executable = androidBinary({
      type: ElfType.Shared,
      interpreter: M2["android-executable"].interpreter,
      needed: M2["android-executable"].needed,
    });
    assert.equal(android(executable), "admitted");
    const system = ["libandroid.so", "liblog.so", "libvulkan.so", "libaaudio.so", "libm.so", "libdl.so", "libc.so"];
    assert.equal(android(androidBinary({ needed: system })), "admitted");
    const admission = admitAndroidElf(androidBinary());
    assert.ok(admission.ok);
    assert.deepEqual(admission.image.loadAlignments, [ANDROID_LOAD_ALIGN_BYTES]);
  });

  const linuxHostile: Array<[string, Uint8Array, string]> = [
    [
      "a libGL import",
      linuxBinary({ needed: [...M2.linux.needed, "libGL.so.1"] }),
      `${NativeRefusal.ImportsLibGl}/${RustAdmissionProblem.OpenGl}`,
    ],
    [
      "ANGLE's libGLESv2.so (a raylib game's, never a Rust one's)",
      linuxBinary({ needed: [...M2.linux.needed, "libGLESv2.so"] }),
      `${NativeRefusal.ImportsLibGl}/${RustAdmissionProblem.OpenGl}`,
    ],
    [
      "a library outside the allow-list (libvulkan.so.1 is dlopened, never linked)",
      linuxBinary({ needed: [...M2.linux.needed, "libvulkan.so.1"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "a network library (libcurl)",
      linuxBinary({ needed: [...M2.linux.needed, "libcurl.so.4"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "glibc 2.29",
      linuxBinary({ versionNeeds: glibc("GLIBC_2.29") }),
      `${NativeRefusal.GlibcTooNew}/${RustAdmissionProblem.GlibcTooNew}`,
    ],
    [
      "an unnumbered glibc version",
      linuxBinary({ versionNeeds: glibc("GLIBC_PRIVATE") }),
      `${NativeRefusal.GlibcTooNew}/${RustAdmissionProblem.GlibcTooNew}`,
    ],
    [
      "a DT_RPATH",
      linuxBinary({ rpath: ["$ORIGIN"] }),
      `${NativeRefusal.RunpathNotOrigin}/${RustAdmissionProblem.SearchPath}`,
    ],
    [
      "a DT_RUNPATH other than $ORIGIN",
      linuxBinary({ runpath: ["/opt/lib"] }),
      `${NativeRefusal.RunpathNotOrigin}/${RustAdmissionProblem.SearchPath}`,
    ],
    [
      "an aarch64 image",
      linuxBinary({ machine: ElfMachine.Aarch64 }),
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.WrongMachine}`,
    ],
    [
      "another dynamic loader",
      linuxBinary({ interpreter: "/tmp/ld.so" }),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.WrongInterpreter}`,
    ],
    [
      "a shared object",
      linuxBinary({ type: ElfType.Shared, interpreter: null }),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.NotAnExecutable}`,
    ],
    ["not an ELF", Buffer.from("#!/bin/sh\n"), `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.Unreadable}`],
  ];
  for (const [label, bytes, expected] of linuxHostile) {
    it(`refuses a Linux build with ${label}, typed`, () => {
      assert.equal(linux(bytes), expected);
    });
  }

  const androidHostile: Array<[string, Uint8Array, string]> = [
    [
      "4 KB-aligned loads (no 16 KB link args)",
      androidBinary({ align: 4096 }),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.LoadAlignment}`,
    ],
    [
      "a network library in DT_NEEDED (libssl)",
      androidBinary({ needed: [...M2.android.needed, "libssl.so"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "an extra shared object of its own (libc++_shared.so)",
      androidBinary({ needed: [...M2.android.needed, "libc++_shared.so"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "a GLES import",
      androidBinary({ needed: [...M2.android.needed, "libGLESv3.so"] }),
      `${NativeRefusal.ImportsLibGl}/${RustAdmissionProblem.OpenGl}`,
    ],
    [
      "an EGL import",
      androidBinary({ needed: [...M2.android.needed, "libEGL.so"] }),
      `${NativeRefusal.ImportsLibGl}/${RustAdmissionProblem.OpenGl}`,
    ],
    [
      "a glibc soname (a Linux build offered as Android)",
      androidBinary({ needed: ["libc.so.6"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "a DT_RUNPATH",
      androidBinary({ runpath: ["$ORIGIN"] }),
      `${NativeRefusal.RunpathNotOrigin}/${RustAdmissionProblem.SearchPath}`,
    ],
    [
      "an x86-64 image",
      androidBinary({ machine: ElfMachine.X64 }),
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.WrongMachine}`,
    ],
    [
      "glibc's dynamic loader",
      androidBinary({ interpreter: "/lib64/ld-linux-x86-64.so.2" }),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.WrongInterpreter}`,
    ],
  ];
  for (const [label, bytes, expected] of androidHostile) {
    it(`refuses an Android build with ${label}, typed`, () => {
      assert.equal(android(bytes), expected);
    });
  }
});
