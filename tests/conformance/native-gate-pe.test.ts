/**
 * The Windows bundle gate (plan §3.9, §8.7, M4b): the host's own PE/COFF reader and the admission
 * of a Windows build's output. Synthetic images come from the pure-TS writer in `helpers/pe.ts`;
 * the store's real ANGLE DLLs and a zig-built x86_64-windows-gnu executable are read when the dev
 * toolchains are present (required under `GENEX_REQUIRE_TOOLCHAINS=1`) and compared with what
 * `native/angle/pe_imports.py`, the CI gate's reader, says about the same bytes.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  opendir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { NativeRefusal, RustAdmissionProblem } from "../../src/shared/native-contract.ts";
import {
  admitRustPe,
  admitWindowsBundle,
  admitWindowsOutput,
  type BundleEntry,
  BundleEntryKind,
  checkWindowsAngleDll,
  type OutputFolderReads,
  PeMachine,
  PeProblem,
  readPe,
  WindowsAngleDll,
  type WindowsAnglePins,
  WindowsExeProblem,
  windowsAnglePins,
} from "../../src/substrate/native-gate-pe.ts";
import { isWindowsSafeName } from "../../src/substrate/windows-names.ts";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { PeFixtureMachine, type PeSpec, patched, writePe } from "../helpers/pe.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { M2, windowsBinary } from "../fixtures/rust-bundles/binaries.ts";

const execFileAsync = promisify(execFile);
const POSIX = process.platform !== "win32";
const ZIG_BUILD_TIMEOUT_MS = 300_000;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** Stand-ins for the store's three DLLs, and the pins a lock would carry for them. */
const ANGLE = {
  [WindowsAngleDll.Egl]: writePe({ dll: true, imports: ["KERNEL32.dll"], exports: ["eglGetProcAddress"] }).bytes,
  [WindowsAngleDll.Gles]: writePe({ dll: true, imports: ["KERNEL32.dll", "dxgi.dll"], exports: ["glClear"] }).bytes,
  [WindowsAngleDll.D3dCompiler]: writePe({ dll: true, imports: ["KERNEL32.dll"], exports: ["D3DCompile"] }).bytes,
};
const PINS: WindowsAnglePins = {
  [WindowsAngleDll.Egl]: sha256(ANGLE[WindowsAngleDll.Egl]),
  [WindowsAngleDll.Gles]: sha256(ANGLE[WindowsAngleDll.Gles]),
  [WindowsAngleDll.D3dCompiler]: sha256(ANGLE[WindowsAngleDll.D3dCompiler]),
};
const GAME_IMPORTS = ["libGLESv2.dll", "KERNEL32.dll", "USER32.dll", "WINMM.dll"];
/** The import directory of a raylib 6.0 game the Windows lane's recipe built with zig 0.16.0 (cross-build smoke). */
const RAYLIB_BUILD_IMPORTS = [
  "KERNEL32.dll",
  ...["convert", "environment", "heap", "private", "runtime", "stdio", "string"].map(
    (part) => `api-ms-win-crt-${part}-l1-1-0.dll`,
  ),
  "libGLESv2.dll",
  "api-ms-win-crt-math-l1-1-0.dll",
  "USER32.dll",
  "WINMM.dll",
  "api-ms-win-crt-time-l1-1-0.dll",
  "api-ms-win-crt-filesystem-l1-1-0.dll",
  "api-ms-win-crt-utility-l1-1-0.dll",
  "SHELL32.dll",
  "GDI32.dll",
  "api-ms-win-crt-locale-l1-1-0.dll",
];
const GAME = writePe({ imports: GAME_IMPORTS }).bytes;
const PNG_HEAD = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const OPTIONS = { exe: "game.exe", pins: PINS };

function file(relative: string, bytes: Uint8Array, extra: Partial<BundleEntry> = {}): BundleEntry {
  return { path: relative, kind: BundleEntryKind.File, links: 1, bytes, whole: true, ...extra };
}

function folder(relative: string): BundleEntry {
  return { path: relative, kind: BundleEntryKind.Directory, links: 1, bytes: new Uint8Array(), whole: true };
}

/** A build's output as admission sees it: the game, its assets and one build-supplied ANGLE DLL. */
function goodEntries(): BundleEntry[] {
  return [
    file("game.exe", GAME),
    folder("assets"),
    file("assets/sprite.png", PNG_HEAD, { whole: false }),
    folder("assets/levels"),
    file("assets/levels/one.json", ascii("{}")),
    file("libEGL.dll", ANGLE[WindowsAngleDll.Egl]),
    file("libGLESv2.dll.lib", ascii("!<arch>\n")),
  ];
}

const replace = (entries: BundleEntry[], relative: string, entry: BundleEntry) =>
  entries.map((each) => (each.path === relative ? entry : each));

/**
 * An import name that runs, unterminated, to the end of its section's file data, where the next
 * section's raw data (file-adjacent) holds the bytes that would finish it: one section, one name.
 */
function nameRunningIntoNextSection(): Uint8Array {
  const first = writePe({ imports: ["a.dll"] }).layout.section;
  const next = { rva: 0x2000, virtualSize: 0x200, rawSize: 0x200, rawPointer: first.offset + first.rawSize };
  const { bytes, layout } = writePe({ imports: ["a.dll"], extraSections: [{ ...next, data: ascii("b.dll\0") }] });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameRva = view.getUint32((layout.importTable ?? 0) + 12, true);
  const nameAt = layout.section.offset + nameRva - layout.section.rva;
  return Uint8Array.from(bytes, (byte, at) => (at >= nameAt && at < next.rawPointer ? 0x61 : byte));
}

/** Malformed images, each with the problem the reader must name. */
function hostileImages(): Array<[string, Uint8Array, PeProblem]> {
  const base = writePe({ imports: ["libGLESv2.dll", "KERNEL32.dll"], exports: ["e"] });
  const { bytes, layout } = base;
  const importDirectory = layout.directories + 8;
  const exportDirectory = layout.exportDirectory ?? 0;
  const delayVa = writePe({ pe32: true, delayImports: ["opengl32.dll"], delayAttributes: 0 });
  return [
    ["an empty file", new Uint8Array(), PeProblem.NoDosHeader],
    ["an ELF image", Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, ...new Uint8Array(60)), PeProblem.NoDosHeader],
    ["only the MZ magic", ascii("MZ"), PeProblem.OutOfBounds],
    ["truncated after the DOS header", bytes.slice(0, 0x40), PeProblem.OutOfBounds],
    ["truncated inside the COFF header", bytes.slice(0, layout.pe + 10), PeProblem.OutOfBounds],
    ["truncated inside the section table", bytes.slice(0, layout.sectionTable + 20), PeProblem.OutOfBounds],
    ["a PE header offset past the end", patched(bytes, 0x3c, 4, 0xffff_fff0), PeProblem.OutOfBounds],
    ["a broken PE signature", patched(bytes, layout.pe, 4, 0x5850), PeProblem.NoPeSignature],
    ["a ROM optional header", patched(bytes, layout.optional, 2, 0x107), PeProblem.BadOptionalHeader],
    [
      "an optional header too small for its directories",
      patched(bytes, layout.optionalSize, 2, 16),
      PeProblem.BadOptionalHeader,
    ],
    ["65535 section headers", patched(bytes, layout.sectionCount, 2, 0xffff), PeProblem.TooManySections],
    [
      "an import directory outside every section",
      patched(bytes, importDirectory, 4, 0x7fff_fff0),
      PeProblem.UnmappedRva,
    ],
    ["an import directory pointing into the headers", patched(bytes, importDirectory, 4, 0x10), PeProblem.UnmappedRva],
    [
      "an import directory in the section's uninitialised tail",
      patched(
        patched(bytes, layout.sectionTable + 8, 4, 0x8000),
        importDirectory,
        4,
        0x1000 + layout.section.rawSize + 8,
      ),
      PeProblem.UninitialisedRva,
    ],
    ["a section whose raw data the file truncates", bytes.slice(0, layout.section.offset + 16), PeProblem.OutOfBounds],
    [
      "a section whose virtual range wraps past 4 GiB",
      patched(patched(bytes, layout.sectionTable + 12, 4, 0xffff_f000), layout.sectionTable + 8, 4, 0x2000),
      PeProblem.BadSectionTable,
    ],
    [
      "a section's raw data at an unaligned offset",
      patched(bytes, layout.sectionTable + 20, 4, 0x3ff),
      PeProblem.BadSectionTable,
    ],
    [
      "two sections mapping the same RVAs",
      writePe({
        imports: ["libGLESv2.dll"],
        extraSections: [{ rva: 0x1000, virtualSize: 0x200, rawSize: 0x200, rawPointer: 0x400 }],
      }).bytes,
      PeProblem.BadSectionTable,
    ],
    [
      "an import name longer than any DLL name",
      writePe({ imports: [`${"a".repeat(600)}.dll`] }).bytes,
      PeProblem.BadName,
    ],
    ["an import name running past its section into the next", nameRunningIntoNextSection(), PeProblem.BadName],
    [
      "a descriptor table repeating past the cap",
      writePe({ imports: Array(4100).fill("x.dll") }).bytes,
      PeProblem.TooManyDescriptors,
    ],
    ["an export count of 2^32-1", patched(bytes, exportDirectory + 24, 4, 0xffff_ffff), PeProblem.TooManyExports],
    [
      "an export name table outside every section",
      patched(bytes, exportDirectory + 32, 4, 0x9000_0000),
      PeProblem.UnmappedRva,
    ],
    [
      "an old-form delay name below the image base",
      patched(delayVa.bytes, (delayVa.layout.delayTable ?? 0) + 4, 4, 0x1000),
      PeProblem.UnmappedRva,
    ],
  ];
}

describe("readPe: the host's own PE/COFF reader", () => {
  it("reads machine, characteristics, imports, delay imports and exports of a PE32+ executable", () => {
    const read = readPe(writePe({ imports: GAME_IMPORTS, delayImports: ["libEGL.dll"] }).bytes);
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.image.machine, PeMachine.X64);
    assert.equal(read.image.pe32Plus, true);
    assert.equal(read.image.dll, false);
    assert.equal(read.image.executable, true);
    assert.deepEqual(read.image.imports, GAME_IMPORTS);
    assert.deepEqual(read.image.delayImports, ["libEGL.dll"]);
    assert.deepEqual(read.image.exports, []);
  });

  it("reads a PE32 x86 DLL whose delay descriptors use the old VA form", () => {
    const bytes = writePe({
      pe32: true,
      dll: true,
      imports: ["KERNEL32.dll"],
      delayImports: ["USER32.dll"],
      delayAttributes: 0,
      exports: ["eglGetProcAddress", "glDrawArrays"],
    }).bytes;
    const read = readPe(bytes);
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.image.machine, PeMachine.X86);
    assert.equal(read.image.pe32Plus, false);
    assert.equal(read.image.dll, true);
    assert.deepEqual(read.image.delayImports, ["USER32.dll"]);
    assert.deepEqual(read.image.exports, ["eglGetProcAddress", "glDrawArrays"]);
  });

  it("names an unknown machine instead of guessing", () => {
    const read = readPe(writePe({ machine: 0xa641 }).bytes);
    assert.ok(read.ok);
    assert.equal(read.image.machine, PeMachine.Other);
    assert.equal(read.image.machineCode, 0xa641);
  });

  it("reads names in file-adjacent sections, each inside its own", () => {
    const first = writePe({ imports: ["a.dll"] }).layout.section;
    const next = { rva: 0x2000, virtualSize: 0x200, rawSize: 0x200, rawPointer: first.offset + first.rawSize };
    const read = readPe(writePe({ imports: ["a.dll"], extraSections: [{ ...next, data: ascii("b.dll\0") }] }).bytes);
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.image.imports, ["a.dll"]);
  });

  it("caps a huge data-directory count at the sixteen the format has", () => {
    const { bytes, layout } = writePe({ imports: ["libGLESv2.dll"] });
    const read = readPe(patched(bytes, layout.directoryCount, 4, 0xffff_ffff));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.image.imports, ["libGLESv2.dll"]);
  });

  describe("hostile images: a typed problem, never a throw, and the input untouched", () => {
    for (const [name, image, problem] of hostileImages()) {
      it(name, () => {
        const before = sha256(image);
        const read = readPe(image);
        assert.equal(read.ok, false, `${name} was read as a PE image`);
        assert.equal(read.ok ? null : read.problem, problem);
        assert.equal(sha256(image), before, "the reader wrote into its input");
      });
    }
  });
});

/** A bundle that breaks one rule, and the refusal (and problem) the gate must name. */
interface AdmissionRow {
  name: string;
  entries: BundleEntry[];
  refusal: NativeRefusal;
  problem?: WindowsExeProblem;
  file: string;
}

const withGame = (entry: BundleEntry) => replace(goodEntries(), "game.exe", entry);
const gameOf = (spec: PeSpec) => withGame(file("game.exe", writePe(spec).bytes));
const plus = (...more: BundleEntry[]) => [...goodEntries(), ...more];

/** Games whose imports break the ANGLE rule, or name a DLL by path or one neither Windows nor the bundle provides. */
function importRows(): AdmissionRow[] {
  const foreign = [NativeRefusal.ForeignImport, WindowsExeProblem.ForeignImport] as const;
  const rows: Array<[string, PeSpec, NativeRefusal, WindowsExeProblem?]> = [
    ["imports opengl32.dll", { imports: [...GAME_IMPORTS, "opengl32.dll"] }, NativeRefusal.ImportsOpengl32],
    ["imports OPENGL32.DLL in capitals", { imports: [...GAME_IMPORTS, "OPENGL32.DLL"] }, NativeRefusal.ImportsOpengl32],
    [
      "delay-loads opengl32.dll",
      { imports: GAME_IMPORTS, delayImports: ["opengl32.dll"] },
      NativeRefusal.ImportsOpengl32,
    ],
    ["imports opengl32 with no extension", { imports: [...GAME_IMPORTS, "opengl32"] }, NativeRefusal.ImportsOpengl32],
    [
      "imports opengl32.dll by a path with a trailing dot",
      { imports: [...GAME_IMPORTS, "C:\\Windows\\System32\\opengl32.dll."] },
      NativeRefusal.ImportsOpengl32,
    ],
    [
      "imports glu32.dll, which loads opengl32.dll",
      { imports: [...GAME_IMPORTS, "GLU32.dll"] },
      NativeRefusal.ImportsOpengl32,
    ],
    [
      "is missing the libGLESv2.dll import",
      { imports: ["KERNEL32.dll", "USER32.dll"] },
      NativeRefusal.MissingAngleImport,
    ],
    ["imports only libEGL.dll", { imports: ["libEGL.dll", "KERNEL32.dll"] }, NativeRefusal.MissingAngleImport],
    [
      "imports libGLESv2.dll only by a drive path",
      { imports: ["C:\\Users\\Public\\libGLESv2.dll", "KERNEL32.dll"] },
      NativeRefusal.MissingAngleImport,
    ],
    [
      "imports libGLESv2.dll only by a relative path",
      { imports: ["..\\..\\evil\\libGLESv2.dll", "KERNEL32.dll"] },
      NativeRefusal.MissingAngleImport,
    ],
    [
      "imports libGLESv2.dll only from a network share",
      { imports: ["\\\\attacker\\share\\libGLESv2.dll", "KERNEL32.dll"] },
      NativeRefusal.MissingAngleImport,
    ],
    [
      "imports libGLESv2.dll only from its assets",
      { imports: ["assets/libGLESv2.dll", "KERNEL32.dll"] },
      NativeRefusal.MissingAngleImport,
    ],
    [
      "imports libGLESv2.dll only with a trailing space",
      { imports: ["libGLESv2.dll ", "KERNEL32.dll"] },
      NativeRefusal.MissingAngleImport,
    ],
    [
      "delay-loads libGLESv2.dll only by a path",
      { imports: ["KERNEL32.dll"], delayImports: ["C:\\angle\\libGLESv2.dll"] },
      NativeRefusal.MissingAngleImport,
    ],
    [
      "also imports a DLL from a network share",
      { imports: [...GAME_IMPORTS, "\\\\attacker\\share\\x.dll"] },
      ...foreign,
    ],
    [
      "also imports libGLESv2.dll by a path",
      { imports: [...GAME_IMPORTS, "C:\\Users\\Public\\libGLESv2.dll"] },
      ...foreign,
    ],
    ["imports a C++ runtime DLL nobody ships", { imports: [...GAME_IMPORTS, "libc++.dll"] }, ...foreign],
    ["delay-loads a DLL nobody ships", { imports: GAME_IMPORTS, delayImports: ["raylib.dll"] }, ...foreign],
    ["imports a system DLL by a stream name", { imports: [...GAME_IMPORTS, "kernel32.dll:x"] }, ...foreign],
    ["imports a device name", { imports: [...GAME_IMPORTS, "CON"] }, ...foreign],
    [
      "imports an API set from a share",
      { imports: [...GAME_IMPORTS, "\\\\h\\s\\api-ms-win-crt-heap-l1-1-0.dll"] },
      ...foreign,
    ],
  ];
  return rows.map(([name, spec, refusal, problem]) => ({
    name,
    entries: gameOf(spec),
    refusal,
    problem,
    file: "game.exe",
  }));
}

/** Bundles carrying one file the gate refuses, named by its path. */
function contentRows(): AdmissionRow[] {
  const peHead = writePe({ dll: true }).bytes.slice(0, 2);
  const link = { ...file("assets/link.png", new Uint8Array()), kind: BundleEntryKind.Symlink };
  const rows: Array<[string, BundleEntry, NativeRefusal, WindowsExeProblem?]> = [
    ["carries an extra DLL", file("helper.dll", writePe({ dll: true }).bytes), NativeRefusal.ExtraPe],
    ["carries a second executable", file("tool.exe", writePe({}).bytes), NativeRefusal.ExtraPe],
    ["hides a PE image among the assets", file("assets/sky.png", peHead, { whole: false }), NativeRefusal.ExtraPe],
    ["names a DLL with a trailing space", file("assets/evil.dll ", ascii("not even a PE")), NativeRefusal.ExtraPe],
    ["names a DLL with a stream suffix", file("helper.dll:s", ascii("not even a PE")), NativeRefusal.ExtraPe],
    ["names an ANGLE DLL with a stream suffix", file("libEGL.dll:x", ascii("not ANGLE")), NativeRefusal.AngleDigest],
    ...[
      "assets/a\\..\\..\\..\\evil.png",
      "assets/x.png:Zone.Identifier",
      "assets/CON.png",
      "assets/aux",
      "assets/Com1.ogg",
      "assets/q?*<>|.txt",
      'assets/say"hi".txt',
      "assets/tab\t.png",
      "assets/trail. ",
      "assets/trail.",
      "assets/levels./one.json",
      "assets./x.png",
      "Assets:s/x.png",
    ].map((name): [string, BundleEntry, NativeRefusal, WindowsExeProblem] => [
      `has an asset Windows cannot hold: ${JSON.stringify(name)}`,
      file(name, PNG_HEAD),
      NativeRefusal.NotAnExecutable,
      WindowsExeProblem.BadPath,
    ]),
    [
      "ships an ANGLE DLL below the top",
      file("assets/libGLESv2.dll", ANGLE[WindowsAngleDll.Gles]),
      NativeRefusal.ExtraPe,
    ],
    ["ships the game twice in two cases", file("GAME.EXE", GAME), NativeRefusal.ExtraPe],
    [
      "ships its own libGLESv2.dll",
      file("libGLESv2.dll", writePe({ dll: true, imports: ["opengl32.dll"] }).bytes),
      NativeRefusal.AngleDigest,
    ],
    [
      "ships a d3dcompiler_47.dll in other capitals with other bytes",
      file("D3DCompiler_47.dll", writePe({ dll: true }).bytes),
      NativeRefusal.AngleDigest,
    ],
    [
      "ships an ANGLE DLL too large to have been read whole",
      file("libGLESv2.dll", ANGLE[WindowsAngleDll.Gles].slice(0, 64), { whole: false }),
      NativeRefusal.AngleDigest,
    ],
    ["carries a link", link, NativeRefusal.Symlink],
    ["carries a hard-linked file", file("assets/levels/two.json", ascii("{}"), { links: 2 }), NativeRefusal.HardLink],
    [
      "names an entry outside its folder",
      file("../escape.png", PNG_HEAD),
      NativeRefusal.NotAnExecutable,
      WindowsExeProblem.BadPath,
    ],
  ];
  return rows.map(([name, entry, refusal, problem]) => ({
    name,
    entries: plus(entry),
    refusal,
    problem,
    file: entry.path,
  }));
}

/** Bundles with no admissible game, and the problem that names why. */
function exeRows(): AdmissionRow[] {
  const unreadable = { ...file("game.exe", new Uint8Array()), kind: BundleEntryKind.Unreadable };
  const rows: Array<[string, BundleEntry[], WindowsExeProblem, NativeRefusal?]> = [
    ["has no game executable", goodEntries().filter((entry) => entry.path !== "game.exe"), WindowsExeProblem.Missing],
    ["has a folder where the game should be", withGame(folder("game.exe")), WindowsExeProblem.Missing],
    ["has a game it could not read", withGame(unreadable), WindowsExeProblem.Unreadable],
    [
      "has a game too large to read whole",
      withGame(file("game.exe", GAME.slice(0, 64), { whole: false })),
      WindowsExeProblem.TooLarge,
    ],
    [
      "has an x86 game",
      gameOf({ pe32: true, imports: GAME_IMPORTS }),
      WindowsExeProblem.WrongMachine,
      NativeRefusal.WrongMachine,
    ],
    [
      "has an arm64 game (machine 0xAA64)",
      gameOf({ machine: PeFixtureMachine.Arm64, imports: GAME_IMPORTS }),
      WindowsExeProblem.WrongMachine,
      NativeRefusal.WrongMachine,
    ],
    [
      "has an x64 machine with a PE32 header",
      gameOf({ pe32: true, machine: PeFixtureMachine.X64, imports: GAME_IMPORTS }),
      WindowsExeProblem.WrongMachine,
      NativeRefusal.WrongMachine,
    ],
    ["has a DLL for a game", gameOf({ dll: true, imports: GAME_IMPORTS }), WindowsExeProblem.NotAnExeImage],
    [
      "has a game not marked executable",
      gameOf({ characteristics: 0x0020, imports: GAME_IMPORTS }),
      WindowsExeProblem.NotAnExeImage,
    ],
    ["has a truncated game", withGame(file("game.exe", GAME.slice(0, 0x100))), WindowsExeProblem.OutOfBounds],
    [
      "has a game that is not a PE image",
      withGame(file("game.exe", ascii("#!/bin/sh\n"))),
      WindowsExeProblem.NoDosHeader,
    ],
  ];
  return rows.map(([name, entries, problem, refusal = NativeRefusal.NotAnExecutable]) => ({
    name,
    entries,
    refusal,
    problem,
    file: "game.exe",
  }));
}

describe("admitWindowsBundle: what a Windows build may hand the host", () => {
  it("admits the x64 game importing libGLESv2.dll, its assets and a store-identical ANGLE DLL", () => {
    const admission = admitWindowsBundle(goodEntries(), OPTIONS);
    assert.ok(admission.ok, JSON.stringify(admission));
    assert.equal(admission.bundle.exe.path, "game.exe");
    assert.equal(sha256(admission.bundle.exe.bytes), sha256(GAME));
    assert.deepEqual(admission.bundle.exe.image.imports, GAME_IMPORTS);
    assert.deepEqual(admission.bundle.assets, ["assets/levels/one.json", "assets/sprite.png"]);
    assert.deepEqual(admission.bundle.suppliedAngle, [WindowsAngleDll.Egl]);
    assert.deepEqual(admission.bundle.ignored, ["libGLESv2.dll.lib"]);
  });

  it("admits a game that also imports libEGL.dll, delay-loads libGLESv2.dll, or names DLLs as a real build does", () => {
    for (const spec of [
      { imports: ["libEGL.dll", "libGLESv2.dll", "KERNEL32.dll"] },
      { imports: ["KERNEL32.dll"], delayImports: ["LIBGLESV2.DLL"] },
      { imports: ["libGLESv2", "kernel32", "d3dcompiler_47.dll", "ADVAPI32.dll", "ntdll.dll", "msvcrt.dll"] },
      { imports: RAYLIB_BUILD_IMPORTS },
    ]) {
      const admission = admitWindowsBundle(
        replace(goodEntries(), "game.exe", file("game.exe", writePe(spec).bytes)),
        OPTIONS,
      );
      assert.ok(admission.ok, JSON.stringify(spec));
    }
  });

  for (const row of [...importRows(), ...contentRows(), ...exeRows()]) {
    it(`refuses a bundle that ${row.name}`, () => {
      const admission = admitWindowsBundle(row.entries, OPTIONS);
      assert.equal(admission.ok, false, `${row.name} was admitted`);
      if (admission.ok) return;
      assert.equal(admission.refusal, row.refusal);
      assert.equal(admission.problem, row.problem ?? null);
      assert.equal(admission.file, row.file);
    });
  }

  it("admits an assets folder in other capitals, as the Mac gate's lookup on APFS does", () => {
    const entries = [
      ...goodEntries().filter((entry) => !entry.path.startsWith("assets")),
      folder("Assets"),
      file("Assets/sprite.png", PNG_HEAD, { whole: false }),
    ];
    const admission = admitWindowsBundle(entries, OPTIONS);
    assert.ok(admission.ok, JSON.stringify(admission));
    assert.deepEqual(admission.bundle.assets, ["Assets/sprite.png"]);
    assert.deepEqual(admission.bundle.ignored, ["libGLESv2.dll.lib"]);
  });

  it("refuses two assets that are one file on Windows", () => {
    for (const twin of [file("assets/Sprite.png", PNG_HEAD), file("Assets/sprite.png", PNG_HEAD)]) {
      const admission = admitWindowsBundle(plus(twin), OPTIONS);
      assert.equal(admission.ok, false, twin.path);
      if (admission.ok) return;
      assert.equal(admission.refusal, NativeRefusal.NotAnExecutable);
      assert.equal(admission.problem, WindowsExeProblem.BadPath);
      assert.ok([twin.path, "assets/sprite.png"].includes(admission.file), admission.file);
    }
  });

  it("names the same first refusal whatever order the entries come in", () => {
    const entries = plus(file("helper.dll", writePe({ dll: true }).bytes), file("assets/a.dll", ascii("text")));
    for (const order of [entries, [...entries].reverse()]) {
      const admission = admitWindowsBundle(order, OPTIONS);
      assert.equal(admission.ok ? null : admission.file, "assets/a.dll");
    }
  });

  it("refuses an executable name the host did not mean as a top-level file", () => {
    for (const exeName of ["", "bin/game.exe", "..", "game.dll"]) {
      const admission = admitWindowsBundle(goodEntries(), { ...OPTIONS, exe: exeName });
      assert.equal(admission.ok, false, exeName);
      assert.equal(admission.ok ? null : admission.problem, WindowsExeProblem.BadPath, exeName);
    }
  });
});

describe("admitWindowsBundle: one Windows name rule (windows-names.ts) for assets and imports", () => {
  it("refuses an asset segment exactly when the shared Windows name rule does, its byte limit included", () => {
    const names = [
      "tile.png",
      "\u03a9.png",
      `${"a".repeat(251)}.png`,
      `${"a".repeat(252)}.png`,
      `${"\u00e9".repeat(127)}.png`,
      "CON.png",
      "trail.",
      "x:y.png",
      "tab\t.png",
    ];
    for (const name of names) {
      for (const relative of [`assets/${name}`, `assets/${name}/x.png`]) {
        const admission = admitWindowsBundle(plus(file(relative, PNG_HEAD)), OPTIONS);
        assert.equal(admission.ok, isWindowsSafeName(name), relative);
        if (admission.ok) continue;
        assert.equal(admission.refusal, NativeRefusal.NotAnExecutable, relative);
        assert.equal(admission.problem, WindowsExeProblem.BadPath, relative);
      }
    }
    assert.equal(admitWindowsBundle(plus(file(`assets/${"a".repeat(252)}.png`, PNG_HEAD)), OPTIONS).ok, false);
  });

  it("refuses two assets one only by Unicode form or by a case Windows folds (\u03c2 and \u03c3)", () => {
    for (const [first, second] of [
      ["assets/caf\u00e9.png", "assets/cafe\u0301.png"],
      ["assets/\u03c2.png", "assets/\u03c3.png"],
    ]) {
      const admission = admitWindowsBundle(plus(file(first, PNG_HEAD), file(second, PNG_HEAD)), OPTIONS);
      assert.equal(admission.ok, false, `${first} and ${second} were admitted together`);
      assert.equal(admission.ok ? null : admission.problem, WindowsExeProblem.BadPath);
    }
  });

  it("finds a system DLL only by a spelling the shared Windows name rule holds", () => {
    const spellings = [
      "KERNEL32.dll",
      "kernel32",
      "Kernel32.DLL",
      "kernel32.dll.",
      "kernel32.dll ",
      "kernel32.dll:x",
      "C:kernel32.dll",
    ];
    for (const name of spellings) {
      const admission = admitWindowsBundle(gameOf({ imports: ["libGLESv2.dll", name] }), OPTIONS);
      assert.equal(admission.ok, isWindowsSafeName(name), JSON.stringify(name));
      if (!admission.ok) assert.equal(admission.refusal, NativeRefusal.ForeignImport, JSON.stringify(name));
    }
  });
});

describe("checkWindowsAngleDll and windowsAnglePins: the host's own copies", () => {
  it("accepts the pinned bytes and refuses a changed byte, a missing pin, an x86 build and an OpenGL import", () => {
    assert.equal(checkWindowsAngleDll(WindowsAngleDll.Egl, ANGLE[WindowsAngleDll.Egl], PINS), null);
    const flipped = ANGLE[WindowsAngleDll.Egl].slice();
    flipped[flipped.length - 1] ^= 1;
    assert.equal(checkWindowsAngleDll(WindowsAngleDll.Egl, flipped, PINS)?.refusal, NativeRefusal.AngleDigest);
    const x86 = writePe({ pe32: true, dll: true });
    const x86Pins = { ...PINS, [WindowsAngleDll.Egl]: sha256(x86.bytes) };
    assert.equal(
      checkWindowsAngleDll(WindowsAngleDll.Egl, x86.bytes, x86Pins)?.problem,
      WindowsExeProblem.WrongMachine,
    );
    const opengl = writePe({ dll: true, imports: ["OPENGL32.dll"] }).bytes;
    const openglPins = { ...PINS, [WindowsAngleDll.Gles]: sha256(opengl) };
    assert.equal(
      checkWindowsAngleDll(WindowsAngleDll.Gles, opengl, openglPins)?.refusal,
      NativeRefusal.ImportsOpengl32,
    );
  });

  it("refuses pinned bytes that are an x64 executable or an x64 DLL with a PE32 header", () => {
    const rows: Array<[string, Uint8Array, WindowsExeProblem]> = [
      ["an x64 executable", writePe({ imports: ["KERNEL32.dll"] }).bytes, WindowsExeProblem.NotADll],
      [
        "an x64 DLL with a PE32 header",
        writePe({ pe32: true, dll: true, machine: PeFixtureMachine.X64 }).bytes,
        WindowsExeProblem.WrongMachine,
      ],
    ];
    for (const [name, bytes, problem] of rows) {
      const refusal = checkWindowsAngleDll(WindowsAngleDll.Gles, bytes, {
        ...PINS,
        [WindowsAngleDll.Gles]: sha256(bytes),
      });
      assert.equal(refusal?.refusal, NativeRefusal.AngleDigest, name);
      assert.equal(refusal?.problem, problem, name);
    }
  });

  it("reads the pins from an ANGLE manifest and refuses one that lacks a well-formed pin", () => {
    const files = Object.fromEntries(Object.entries(PINS).map(([name, digest]) => [name, { sha256: digest, size: 1 }]));
    assert.deepEqual(windowsAnglePins({ files }), PINS);
    for (const manifest of [
      null,
      [],
      { files: null },
      { files: { ...files, [WindowsAngleDll.D3dCompiler]: undefined } },
      { files: { ...files, [WindowsAngleDll.Egl]: { sha256: "ABC" } } },
      { files: { ...files, [WindowsAngleDll.Gles]: { sha256: PINS[WindowsAngleDll.Gles].toUpperCase() } } },
    ]) {
      assert.equal(windowsAnglePins(manifest), null, JSON.stringify(manifest));
    }
  });
});

/** Everything under `root`, without following a link: type, size, mode, mtime, bytes' digest and link target. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      const rel = path.relative(root, full);
      if (info.isSymbolicLink()) out[rel] = `link ${await readlink(full)}`;
      else if (info.isDirectory()) {
        out[rel] = `dir ${info.mode} ${info.mtimeMs}`;
        await walk(full);
      } else if (info.isFile())
        out[rel] = `file ${info.size} ${info.mode} ${info.mtimeMs} ${sha256(await readFile(full))}`;
      else out[rel] = `other ${info.mode}`;
    }
  };
  await walk(root);
  return out;
}

/** A Windows build's output folder on disk, the way the lane leaves it, plus a sibling folder outside it. */
async function outputFolder(): Promise<{ out: string; outside: string }> {
  const root = await tmpDir("pe-gate-");
  const out = path.join(root, "out");
  const outside = path.join(root, "outside");
  await mkdir(path.join(out, "assets", "levels"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(out, "game.exe"), GAME);
  await writeFile(path.join(out, "assets", "sprite.png"), PNG_HEAD);
  await writeFile(path.join(out, "assets", "levels", "one.json"), "{}");
  await writeFile(path.join(out, WindowsAngleDll.Egl), ANGLE[WindowsAngleDll.Egl]);
  await writeFile(path.join(outside, "secret.txt"), "not for the bundle");
  await writeFile(path.join(outside, "other.exe"), writePe({ imports: ["opengl32.dll"] }).bytes);
  return { out, outside };
}

/** An output folder that breaks one rule; `arrange` may name another folder to admit. */
interface OutputRow {
  name: string;
  posixOnly?: boolean;
  arrange: (out: string, outside: string) => Promise<string | undefined>;
  refusal: NativeRefusal;
  problem?: WindowsExeProblem;
  limits?: { entries?: number; depth?: number; exeBytes?: number; angleBytes?: number };
}

/** Output folders arranged on disk to break one rule each. */
const OUTPUT_ROWS: OutputRow[] = [
  {
    name: "a game that is a link to an executable outside",
    posixOnly: true,
    arrange: async (out, outside) => {
      const target = path.join(outside, "game-copy.exe");
      await copyFile(path.join(out, "game.exe"), target);
      await rm(path.join(out, "game.exe"));
      await symlink(target, path.join(out, "game.exe"));
      return undefined;
    },
    refusal: NativeRefusal.Symlink,
  },
  {
    name: "an assets folder that is a link outside",
    posixOnly: true,
    arrange: async (out, outside) => {
      await symlink(outside, path.join(out, "assets", "levels", "more"));
      return undefined;
    },
    refusal: NativeRefusal.Symlink,
  },
  {
    name: "the output folder itself being a link",
    posixOnly: true,
    arrange: async (out) => {
      const alias = `${out}-alias`;
      await symlink(out, alias);
      return alias;
    },
    refusal: NativeRefusal.Symlink,
  },
  {
    name: "a hard-linked game",
    arrange: async (out, outside) => {
      await link(path.join(out, "game.exe"), path.join(outside, "game-link.exe"));
      return undefined;
    },
    refusal: NativeRefusal.HardLink,
  },
  {
    name: "a FIFO where the game should be",
    posixOnly: true,
    arrange: async (out) => {
      await rm(path.join(out, "game.exe"));
      await execFileAsync("/usr/bin/mkfifo", [path.join(out, "game.exe")]);
      return undefined;
    },
    refusal: NativeRefusal.NotAnExecutable,
    problem: WindowsExeProblem.Missing,
  },
  {
    name: "a missing output folder",
    arrange: async (out) => path.join(out, "nowhere"),
    refusal: NativeRefusal.NotAnExecutable,
    problem: WindowsExeProblem.Unreadable,
  },
  {
    name: "an output folder that is a file",
    arrange: async (out) => path.join(out, "game.exe"),
    refusal: NativeRefusal.NotAnExecutable,
    problem: WindowsExeProblem.Unreadable,
  },
  {
    name: "folders nested past the depth cap",
    arrange: async (out) => {
      await mkdir(path.join(out, "assets", "a", "b", "c", "d"), { recursive: true });
      return undefined;
    },
    limits: { depth: 3 },
    refusal: NativeRefusal.NotAnExecutable,
    problem: WindowsExeProblem.TooManyEntries,
  },
  {
    name: "more entries than the cap",
    arrange: async (out) => {
      for (let index = 0; index < 8; index++) await writeFile(path.join(out, "assets", `tile-${index}.png`), PNG_HEAD);
      return undefined;
    },
    limits: { entries: 6 },
    refusal: NativeRefusal.NotAnExecutable,
    problem: WindowsExeProblem.TooManyEntries,
  },
  {
    name: "a game larger than the executable cap",
    arrange: async () => undefined,
    limits: { exeBytes: 512 },
    refusal: NativeRefusal.NotAnExecutable,
    problem: WindowsExeProblem.TooLarge,
  },
  {
    name: "an ANGLE DLL larger than its cap",
    arrange: async () => undefined,
    limits: { angleBytes: 512 },
    refusal: NativeRefusal.AngleDigest,
  },
  {
    name: "a PE image renamed as an asset",
    arrange: async (out) => {
      await writeFile(path.join(out, "assets", "music.ogg"), writePe({ dll: true }).bytes);
      return undefined;
    },
    refusal: NativeRefusal.ExtraPe,
  },
];

describe("admitWindowsOutput: reading a build's output folder", () => {
  it("admits a well-formed folder and returns the executable bytes it checked", async () => {
    const { out } = await outputFolder();
    const before = await snapshot(out);
    const admission = await admitWindowsOutput(out, OPTIONS);
    assert.ok(admission.ok, JSON.stringify(admission));
    assert.equal(sha256(admission.bundle.exe.bytes), sha256(GAME));
    assert.deepEqual(admission.bundle.assets, ["assets/levels/one.json", "assets/sprite.png"]);
    assert.deepEqual(admission.bundle.suppliedAngle, [WindowsAngleDll.Egl]);
    assert.deepEqual(await snapshot(out), before, "admission wrote into the output folder");
  });

  for (const row of OUTPUT_ROWS) {
    it(`refuses ${row.name}, and changes nothing`, {
      skip: row.posixOnly && !POSIX ? "needs POSIX links" : false,
    }, async () => {
      const { out, outside } = await outputFolder();
      const target = (await row.arrange(out, outside)) ?? out;
      const parent = path.dirname(out);
      const before = await snapshot(parent);
      const admission = await admitWindowsOutput(target, { ...OPTIONS, limits: row.limits });
      assert.equal(admission.ok, false, `${row.name} was admitted`);
      if (admission.ok) return;
      assert.equal(admission.refusal, row.refusal, JSON.stringify(admission));
      assert.equal(admission.problem, row.problem ?? null);
      assert.deepEqual(await snapshot(parent), before, "admission changed the folder or what it points at");
    });
  }

  it("refuses a folder swapped for another while it was being listed, and changes nothing", async () => {
    const { out, outside } = await outputFolder();
    const before = await snapshot(path.dirname(out));
    const assets = path.join(out, "assets");
    let looks = 0;
    const reads: OutputFolderReads = {
      opendir,
      lstat: async (each) => {
        if (each !== assets) return lstat(each);
        looks += 1;
        return lstat(looks > 1 ? outside : each);
      },
    };
    const admission = await admitWindowsOutput(out, { ...OPTIONS, reads });
    assert.equal(admission.ok, false, "a swapped folder was admitted");
    if (admission.ok) return;
    assert.equal(admission.refusal, NativeRefusal.Symlink);
    assert.equal(admission.file, "assets");
    assert.deepEqual(await snapshot(path.dirname(out)), before);
  });

  it("refuses a file swapped for another between the walk and its open, and changes nothing", async () => {
    const { out } = await outputFolder();
    const before = await snapshot(path.dirname(out));
    const sprite = path.join(out, "assets", "sprite.png");
    const other = path.join(out, "assets", "levels", "one.json");
    const reads: OutputFolderReads = { opendir, lstat: (each) => lstat(each === sprite ? other : each) };
    const admission = await admitWindowsOutput(out, { ...OPTIONS, reads });
    assert.equal(admission.ok, false, "a file the walk did not see was admitted");
    if (admission.ok) return;
    assert.equal(admission.refusal, NativeRefusal.Symlink);
    assert.equal(admission.file, "assets/sprite.png");
    assert.deepEqual(await snapshot(path.dirname(out)), before);
  });

  it("stops listing a folder at the entry cap instead of reading every name first", async () => {
    const { out } = await outputFolder();
    const [sample] = await readdir(out, { withFileTypes: true });
    assert.ok(sample);
    let reads = 0;
    /** A listing far longer than the cap; it ends after 500 names so a gate that reads it all fails, not hangs. */
    const endless = {
      read: async () => {
        reads += 1;
        return reads > 500 ? null : sample;
      },
      close: async () => {},
    };
    const admission = await admitWindowsOutput(out, {
      ...OPTIONS,
      limits: { entries: 50 },
      reads: { lstat, opendir: async () => endless },
    });
    assert.equal(admission.ok ? null : admission.problem, WindowsExeProblem.TooManyEntries);
    assert.equal(reads, 51, "the walk read past the cap");
  });
});

/** What the CI gate's own reader (`native/angle/pe_imports.py`) says about each file, run on emsdk's Python. */
async function pythonFacts(files: string[]): Promise<Array<Record<string, unknown>>> {
  const python = devTool("emsdkPython");
  if ("skip" in python) throw new Error(python.skip);
  const angle = path.resolve(import.meta.dirname, "../../native/angle");
  const script = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from pe_imports import pe_facts",
    "print(json.dumps([pe_facts(open(p, 'rb').read()) for p in sys.argv[2:]]))",
  ].join("\n");
  const { stdout } = await execFileAsync(python.path, ["-B", "-c", script, angle, ...files], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Array<Record<string, unknown>>;
}

/** The facts `readPe` gives, in `pe_facts`'s shape. */
function ourFacts(bytes: Uint8Array): Record<string, unknown> {
  const read = readPe(bytes);
  assert.ok(read.ok, JSON.stringify(read));
  const { machine, dll, imports, delayImports, exports } = read.image;
  return { machine, dll, imports, delayImports, exports };
}

/** The part of a Windows ANGLE `manifest.json` the CI gate wrote: `pe_imports.py`'s facts per DLL. */
interface RecordedManifest {
  files: unknown;
  facts: Record<string, { machine: string; imports: string[]; delayImports: string[]; exports: number }>;
}

describe("the store's real ANGLE DLLs", () => {
  const options = needsTools("angleWindows");
  it("reads each DLL as the CI gate recorded it, and checks it against the manifest's pins", options, async () => {
    const angle = devTool("angleWindows");
    if ("skip" in angle) return;
    const manifest: RecordedManifest = JSON.parse(await readFile(path.join(angle.path, "manifest.json"), "utf8"));
    const pins = windowsAnglePins(manifest);
    assert.ok(pins, "the store's manifest pins all three DLLs");
    for (const name of Object.values(WindowsAngleDll)) {
      const bytes: Uint8Array = await readFile(path.join(angle.path, name));
      const read = readPe(bytes);
      assert.ok(read.ok, `${name}: ${JSON.stringify(read)}`);
      const recorded = manifest.facts[name];
      assert.equal(read.image.machine, recorded.machine, name);
      assert.equal(read.image.dll, true, name);
      assert.deepEqual(read.image.imports, recorded.imports, name);
      assert.deepEqual(read.image.delayImports, recorded.delayImports, name);
      assert.equal(read.image.exports.length, recorded.exports, name);
      assert.equal(checkWindowsAngleDll(name, bytes, pins), null, name);
    }
  });

  it("lists exactly the exports pe_imports.py lists", needsTools("angleWindows", "emsdkPython"), async () => {
    const angle = devTool("angleWindows");
    if ("skip" in angle) return;
    const files = Object.values(WindowsAngleDll).map((name) => path.join(angle.path, name));
    const theirs = await pythonFacts(files);
    for (const [index, each] of files.entries()) {
      assert.deepEqual(ourFacts(await readFile(each)), theirs[index], each);
    }
  });
});

/** Builds `source` for x86_64-windows-gnu with zig into `dir/name`, with zig's caches inside `dir`. */
async function zigExe(dir: string, name: string, source: string, link: string[]): Promise<string> {
  const zig = devTool("zig");
  const angle = devTool("angleWindows");
  if ("skip" in zig || "skip" in angle) throw new Error("zig and the Windows ANGLE are required");
  const sourceFile = path.join(dir, `${name}.c`);
  const output = path.join(dir, `${name}.exe`);
  await writeFile(sourceFile, source);
  const args = ["cc", "-target", "x86_64-windows-gnu", "-O1", "-fno-sanitize=all"];
  args.push("-I", path.join(angle.path, "include"), "-o", output, sourceFile, ...link);
  await execFileAsync(zig.path, args, {
    cwd: dir,
    timeout: ZIG_BUILD_TIMEOUT_MS,
    env: {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: path.join(dir, "zig-global"),
      ZIG_LOCAL_CACHE_DIR: path.join(dir, "zig-local"),
    },
  });
  return output;
}

const GLES_GAME = `#include <GLES3/gl3.h>
#include <windows.h>
int main(void) {
  HMODULE egl = LoadLibraryA("libEGL.dll");
  glClear(GL_COLOR_BUFFER_BIT);
  return egl ? 0 : 1;
}
`;
const OPENGL_GAME = `#include <GLES3/gl3.h>
#include <windows.h>
int main(void) {
  glClear(GL_COLOR_BUFFER_BIT);
  return wglGetCurrentContext() ? 0 : 1;
}
`;
const PLAIN_GAME = `#include <windows.h>
int main(void) { return GetTickCount() > 0 ? 0 : 1; }
`;

describe("a real zig-built x86_64-windows-gnu executable", () => {
  it(
    "is read as pe_imports.py reads it and gated by its real imports",
    needsTools("zig", "angleWindows", "emsdkPython"),
    async () => {
      const angle = devTool("angleWindows");
      if ("skip" in angle) return;
      const work = await tmpDir("pe-gate-zig-");
      const gles = path.join(angle.path, "libGLESv2.dll.lib");
      const builds = {
        game: await zigExe(work, "game", GLES_GAME, [gles]),
        opengl: await zigExe(work, "opengl", OPENGL_GAME, [gles, "-lopengl32"]),
        plain: await zigExe(work, "plain", PLAIN_GAME, []),
      };
      const files = Object.values(builds);
      const theirs = await pythonFacts(files);
      for (const [index, each] of files.entries()) {
        assert.deepEqual(ourFacts(await readFile(each)), theirs[index], each);
      }
      const pins = windowsAnglePins(JSON.parse(await readFile(path.join(angle.path, "manifest.json"), "utf8")));
      assert.ok(pins);
      const expected: Array<[string, NativeRefusal | null]> = [
        [builds.game, null],
        [builds.opengl, NativeRefusal.ImportsOpengl32],
        [builds.plain, NativeRefusal.MissingAngleImport],
      ];
      for (const [exe, refusal] of expected) {
        const out = path.join(work, `out-${path.basename(exe, ".exe")}`);
        await mkdir(path.join(out, "assets"), { recursive: true });
        await copyFile(exe, path.join(out, "game.exe"));
        for (const name of Object.values(WindowsAngleDll))
          await copyFile(path.join(angle.path, name), path.join(out, name));
        await writeFile(path.join(out, "assets", "sprite.png"), PNG_HEAD);
        const admission = await admitWindowsOutput(out, { exe: "game.exe", pins });
        assert.equal(
          admission.ok ? null : admission.refusal,
          refusal,
          `${exe}: ${JSON.stringify(admission.ok ? admission.bundle.exe.image : admission)}`,
        );
      }
    },
  );
});

describe("Rust · wgpu PE admission for Windows (M3.5)", () => {
  const verdict = (bytes: Uint8Array) => {
    const admission = admitRustPe(bytes);
    return admission.ok ? "admitted" : `${admission.refusal}/${admission.problem}`;
  };

  it("admits the Windows build M2 linked, and the D3D12 set loaded at link time or delayed", () => {
    assert.equal(verdict(windowsBinary()), "admitted");
    const d3d = ["d3d12.dll", "dxgi.dll", "d3dcompiler_47.dll"];
    assert.equal(verdict(windowsBinary({ imports: [...M2.windows.imports, ...d3d] })), "admitted");
    assert.equal(verdict(windowsBinary({ delayImports: ["D3D12.dll", "d3dcompiler_47"] })), "admitted");
    const admission = admitRustPe(windowsBinary());
    assert.ok(admission.ok);
    assert.deepEqual(admission.image.imports, M2.windows.imports);
  });

  const hostile: Array<[string, Uint8Array, string]> = [
    [
      "a dxcompiler.dll import",
      windowsBinary({ imports: [...M2.windows.imports, "dxcompiler.dll"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.DxCompiler}`,
    ],
    [
      "a delay-loaded dxil.dll",
      windowsBinary({ delayImports: ["DXIL.dll"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.DxCompiler}`,
    ],
    [
      "an opengl32.dll import",
      windowsBinary({ imports: [...M2.windows.imports, "OPENGL32.dll"] }),
      `${NativeRefusal.ImportsOpengl32}/${RustAdmissionProblem.OpenGl}`,
    ],
    [
      "ANGLE's libGLESv2.dll (a raylib game's, never a Rust one's)",
      windowsBinary({ imports: [...M2.windows.imports, "libGLESv2.dll"] }),
      `${NativeRefusal.ImportsOpengl32}/${RustAdmissionProblem.OpenGl}`,
    ],
    [
      "a network library (winhttp.dll)",
      windowsBinary({ imports: [...M2.windows.imports, "winhttp.dll"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "the old msvcrt.dll beside the UCRT",
      windowsBinary({ imports: [...M2.windows.imports, "msvcrt.dll"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "a DLL of its own",
      windowsBinary({ imports: [...M2.windows.imports, "game_helper.dll"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "an allowed DLL by a path",
      windowsBinary({ imports: ["C:\\Windows\\System32\\kernel32.dll"] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "an x86 image",
      windowsBinary({ machine: PeFixtureMachine.X86 }),
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.WrongMachine}`,
    ],
    [
      "an arm64 image",
      windowsBinary({ machine: PeFixtureMachine.Arm64 }),
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.WrongMachine}`,
    ],
    [
      "a DLL, not an executable",
      windowsBinary({ dll: true }),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.NotAnExecutable}`,
    ],
    [
      "no PE at all",
      ascii("MZ but nothing after"),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.Unreadable}`,
    ],
  ];
  for (const [label, bytes, expected] of hostile) {
    it(`refuses ${label}, typed`, () => {
      assert.equal(verdict(bytes), expected);
    });
  }
});
