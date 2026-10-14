/**
 * The Windows zip and Linux tar.gz exports of an admitted cross build
 * (`src/substrate/native-export-desktop.ts`, plan §7.7 / M4b, D20): the layouts read back by the
 * system's `unzip` and `tar`; the licences each destination ships; `SHA256SUMS` that verifies; the
 * admitted executable bytes, never a file swapped in after admission; store files held to their
 * pins; held credentials refused; byte-identical output; jsign only when the person chose it, in
 * the sandbox, with the password only in its environment and the network only to the timestamp
 * host; and hostile archive targets refused with nothing written. The real rows export the head
 * start's zig-built packages with the dev store's ANGLE and licences, then admit the extracted
 * trees again (required when present: `GENEX_REQUIRE_TOOLCHAINS=1`).
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { inspect, promisify } from "node:util";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  ExportError,
  ExportRefusal,
  ExportSigning,
  GpuQualification,
  JsignStoreType,
  TIMESTAMP_AUTHORITIES,
} from "../../src/shared/game-export-contract.ts";
import { BuildTarget, type GameProject, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { NativeRefusal } from "../../src/shared/native-contract.ts";
import { type MacNotice, NoticeSourceKind } from "../../src/substrate/native-export.ts";
import { windowsBinary } from "../fixtures/rust-bundles/binaries.ts";
import { ToolchainHost, ToolchainId } from "../../src/shared/toolchain.ts";
import { admitCrossOutput, type CrossAngle } from "../../src/substrate/native-cross-admission.ts";
import {
  ArchiveRefusal,
  NativeArchiveError,
  NOTICES_FILE,
  NOTICES_FOLDER,
  README_FILE,
  SUMS_FILE,
} from "../../src/substrate/native-export-archive.ts";
import {
  DesktopExportError,
  DesktopExportProblem,
  exportLinuxTarball,
  exportRustWindowsZip,
  exportWindowsZip,
  type LinuxExportRequest,
  type RustWindowsExportRequest,
  type WindowsExportDeps,
  type WindowsExportRequest,
} from "../../src/substrate/native-export-desktop.ts";
import { LINUX_HOST_FILES } from "../../src/substrate/native-gate-elf.ts";
import { WindowsAngleDll } from "../../src/substrate/native-gate-pe.ts";
import { manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import {
  JSIGN_STOREPASS_ENV,
  type JsignRun,
  type JsignRunResult,
  type OwnCertificateChoice,
  SigningRequester,
  WindowsSignError,
  WindowsSignProblem,
  WindowsSigningKind,
} from "../../src/substrate/windows-sign.ts";
import { devCrossPackage, devTool, needsCrossPackage, needsTools } from "../helpers/dev-toolchains.ts";
import { ElfType, writeElf } from "../helpers/elf.ts";
import { writePe } from "../helpers/pe.ts";
import { tmpDir } from "../helpers/tmp.ts";

import {
  exportDesktopGame,
  exportRefusalOf,
  type DesktopExportGameDeps,
} from "../../src/main/core/native-export-run.ts";
import { raylibLanes } from "../helpers/game-lanes.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const run = promisify(execFile);
const POSIX = process.platform !== "win32";
const PASSWORD = "hunter2-correct-horse";
const TOKEN = "sk-live-0123456789abcdef";

function hasTool(name: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const UNZIP = POSIX && hasTool("unzip");
const TAR = POSIX && hasTool("tar");

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Synthetic ANGLE DLLs and a game that imports them: what the PE gate admits. */
const WINDOWS_DLLS = {
  [WindowsAngleDll.Egl]: writePe({ dll: true, imports: ["KERNEL32.dll"], exports: ["eglGetProcAddress"] }).bytes,
  [WindowsAngleDll.Gles]: writePe({ dll: true, imports: ["KERNEL32.dll", "dxgi.dll"], exports: ["glClear"] }).bytes,
  [WindowsAngleDll.D3dCompiler]: writePe({ dll: true, imports: ["KERNEL32.dll"], exports: ["D3DCompile"] }).bytes,
};
const GAME_EXE = writePe({ imports: ["libGLESv2.dll", "KERNEL32.dll", "USER32.dll", "WINMM.dll"] }).bytes;
const OTHER_EXE = writePe({ imports: ["libGLESv2.dll", "KERNEL32.dll", "GDI32.dll"] }).bytes;
const OPENGL_EXE = writePe({ imports: ["opengl32.dll", "libGLESv2.dll", "KERNEL32.dll"] }).bytes;

/** A synthetic Linux host library, as the ELF gate sees the store's ANGLE. */
const hostLibrary = (soname: string): Buffer =>
  writeElf({
    type: ElfType.Shared,
    interpreter: null,
    soname,
    needed: ["libc.so.6"],
    runpath: [],
    versionNeeds: [{ file: "libc.so.6", names: ["GLIBC_2.2.5", "GLIBC_2.17"] }],
  }).bytes;
const LINUX_FILES: Record<string, Uint8Array> = {
  "libEGL.so": hostLibrary("libEGL.so"),
  "libGLESv2.so": hostLibrary("libGLESv2.so"),
  "libvulkan.so.1": hostLibrary("libvulkan.so.1"),
  "libvk_swiftshader.so": hostLibrary("libvk_swiftshader.so"),
  "vk_swiftshader_icd.json": Buffer.from('{"ICD":{"library_path":"./libvk_swiftshader.so"}}\n'),
};
const LINUX_GAME = writeElf().bytes;
const LINUX_OTHER_GAME = writeElf({ needed: ["libGLESv2.so", "libc.so.6"] }).bytes;

const LLVM_LICENCE = "Apache License v2.0 with LLVM Exceptions (libc++abi and libunwind)";
const WAYLAND_COPYRIGHT = "Copyright © 2008-2013 Kristian Høgsberg";
const MINIAUDIO_HEADER_CODE = "#define MINIAUDIO_IMPLEMENTATION_ONLY_CODE";

/** A store folder whose `manifest.json` pins every file in it; its pin is that manifest's sha256. */
async function pinnedFolder(dir: string, files: Record<string, Uint8Array | string>): Promise<CrossAngle> {
  const listed: Record<string, { sha256: string; size: number }> = {};
  for (const [rel, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), bytes);
    listed[rel] = { sha256: sha256(bytes), size: Buffer.byteLength(bytes) };
  }
  const manifest = `${JSON.stringify({ schema: 1, files: listed }, null, 2)}\n`;
  await writeFile(path.join(dir, "manifest.json"), manifest);
  return { dir, manifestSha256: sha256(manifest) };
}

/** Writes each `rel → text` under `dir`. */
async function writeTree(dir: string, files: Record<string, Uint8Array | string>): Promise<void> {
  for (const [rel, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), bytes);
  }
}

const WAYLAND_CODE = (protocol: string) =>
  [
    "/* Generated by wayland-scanner 1.21.0 */",
    "",
    "/*",
    ` * ${WAYLAND_COPYRIGHT}`,
    " *",
    ` * Permission is hereby granted, free of charge (${protocol}).`,
    " */",
    "",
    "#include <stdlib.h>",
    "",
  ].join("\n");

interface Rig {
  base: string;
  game: string;
  out: string;
  angle: CrossAngle;
  zig: string;
  raylib: string;
  sysroot: CrossAngle;
  dest: string;
}

/** A game, a lane `out/`, a store (ANGLE, zig, raylib, sysroot) and an empty destination folder. */
async function rig(target: typeof BuildTarget.Windows | typeof BuildTarget.Linux): Promise<Rig> {
  const base = await tmpDir("desktop-export-");
  const store = path.join(base, "store");
  const zig = path.join(store, "zig");
  await writeTree(zig, {
    LICENSE: "The MIT License (Expat) Copyright (c) Zig contributors",
    "lib/libc/mingw/COPYING": "Zope Public License (ZPL) Version 2.1, the mingw-w64 project",
    "lib/libcxx/LICENSE.TXT": "Apache License v2.0 with LLVM Exceptions (libc++)",
    "lib/libcxxabi/LICENSE.TXT": LLVM_LICENCE,
    "lib/libunwind/LICENSE.TXT": LLVM_LICENCE,
  });
  const raylib = path.join(store, "raylib");
  await writeTree(raylib, {
    LICENSE: "raylib is licensed under an unmodified zlib/libpng license",
    "src/external/glfw/LICENSE.md": "GLFW zlib/libpng licence, Camilla Löwy",
    "src/external/miniaudio.h": [
      "/* miniaudio - v0.11 */",
      MINIAUDIO_HEADER_CODE,
      "/*",
      "This software is available as a choice of the following licenses. Choose",
      "whichever you prefer.",
      "",
      "ALTERNATIVE 2 - MIT No Attribution",
      "Copyright 2025 David Reid",
      "*/",
      "",
    ].join("\n"),
  });
  const licences = {
    "licenses/angle.txt": "ANGLE BSD-3-Clause, The ANGLE Project Authors",
    "licenses/third_party_zlib.txt": "zlib licence (ANGLE's copy)",
  };
  const angle =
    target === BuildTarget.Windows
      ? await pinnedFolder(path.join(store, "angle-windows"), { ...WINDOWS_DLLS, ...licences })
      : await pinnedFolder(path.join(store, "angle-linux"), {
          ...LINUX_FILES,
          ...licences,
          "licenses/third_party_SwiftShader.txt": "SwiftShader Apache-2.0, The SwiftShader Authors",
        });
  const sysroot = await pinnedFolder(path.join(store, "sysroot"), {
    "glfw-wayland/xdg-shell-client-protocol-code.h": WAYLAND_CODE("xdg-shell"),
    "glfw-wayland/viewporter-client-protocol-code.h": WAYLAND_CODE("viewporter"),
    "glfw-wayland/viewporter-client-protocol.h": "/* the header, not compiled code */",
    "usr/include/X11/Xlib.h": "/* Xlib */",
  });
  const game = path.join(base, "game");
  await writeTree(game, {
    "third_party/README.md": "Small libraries this game vendors.",
    "third_party/stb/LICENSE": "stb: public domain or MIT, Sean Barrett",
    "third_party/stb/stb_perlin.h": "/* code */",
    "src/main.cpp": "int main() {}",
  });
  const out = path.join(base, "out");
  const assets = { "assets/sprites/hero.png": "hero pixels", "assets/level.json": '{"tiles":[0,1]}' };
  if (target === BuildTarget.Windows) {
    await writeTree(out, { "game.exe": GAME_EXE, "game.pdb": "debug info", ...assets });
  } else {
    await writeTree(out, assets);
    await writeFile(path.join(out, "game"), LINUX_GAME, { mode: 0o755 });
  }
  const dest = path.join(base, "dest");
  await mkdir(dest);
  return { base, game, out, angle, zig, raylib, sysroot, dest };
}

function windowsRequest(r: Rig, overrides: Partial<WindowsExportRequest> = {}): WindowsExportRequest {
  return {
    title: "Space Rocks",
    game: r.game,
    out: r.out,
    angle: r.angle,
    zig: r.zig,
    raylib: r.raylib,
    archive: path.join(r.dest, "Space Rocks-windows-x64.zip"),
    builtOn: StudioPlatform.Mac,
    ranOnTarget: false,
    secretValues: [],
    ...overrides,
  };
}

function linuxRequest(r: Rig, overrides: Partial<LinuxExportRequest> = {}): LinuxExportRequest {
  return {
    title: "Space Rocks",
    game: r.game,
    out: r.out,
    angle: r.angle,
    zig: r.zig,
    raylib: r.raylib,
    sysroot: r.sysroot,
    archive: path.join(r.dest, "space-rocks-linux-x64.tar.gz"),
    builtOn: StudioPlatform.Mac,
    ranOnTarget: false,
    secretValues: [],
    ...overrides,
  };
}

/** Every entry under `root` with its kind, size and modification time: "nothing written" is checked by it. */
async function facts(root: string): Promise<string[]> {
  const seen: string[] = [];
  for (const rel of (await readdir(root, { recursive: true })).sort()) {
    const info = await lstat(path.join(root, rel));
    seen.push(`${rel}:${info.isSymbolicLink() ? "link" : info.size}:${info.mtimeMs}`);
  }
  return seen;
}

/** Asserts `write` is refused with an error of `kind` whose `code` is `code`. */
async function refused(
  write: () => Promise<unknown>,
  kind: typeof DesktopExportError | typeof NativeArchiveError | typeof WindowsSignError,
  code: string,
  label?: string,
): Promise<unknown> {
  let caught: unknown = null;
  await assert.rejects(
    write,
    (error: unknown) => {
      assert.ok(error instanceof kind, `${label ?? ""}: ${inspect(error)}`);
      assert.equal((error as { code: string }).code, code, label);
      caught = error;
      return true;
    },
    label,
  );
  return caught;
}

/** The names `unzip -Z1` lists, in order. */
async function zipNames(file: string): Promise<string[]> {
  const { stdout } = await run("/usr/bin/unzip", ["-Z1", file]);
  return stdout.trim().split("\n");
}

/** The names `tar -tzf` lists, in order. */
async function tarNames(file: string): Promise<string[]> {
  const { stdout } = await run("tar", ["-tzf", file]);
  return stdout.trim().split("\n");
}

/** Extracts `file` into a fresh folder beside it with the system tool; answers that folder. */
async function extract(file: string): Promise<string> {
  const into = path.join(path.dirname(path.dirname(file)), `x-${path.basename(file)}`);
  await mkdir(into);
  if (file.endsWith(".zip")) await run("/usr/bin/unzip", ["-q", file, "-d", into]);
  else await run("tar", ["-xzf", file, "-C", into]);
  return into;
}

/** Each `SHA256SUMS` line's file, checked against its digest; answers the listed names. */
async function verifySums(folder: string): Promise<string[]> {
  const lines = (await readFile(path.join(folder, SUMS_FILE), "utf8")).trim().split("\n");
  const names: string[] = [];
  for (const line of lines) {
    const [digest, name] = line.split("  ");
    assert.equal(sha256(await readFile(path.join(folder, ...name.split("/")))), digest, name);
    names.push(name);
  }
  return names;
}

const WINDOWS_ENTRIES = [
  "Space Rocks/",
  `Space Rocks/${README_FILE}`,
  "Space Rocks/Space Rocks.exe",
  `Space Rocks/${NOTICES_FILE}`,
  "Space Rocks/assets/",
  "Space Rocks/assets/level.json",
  "Space Rocks/assets/sprites/",
  "Space Rocks/assets/sprites/hero.png",
  "Space Rocks/d3dcompiler_47.dll",
  "Space Rocks/libEGL.dll",
  "Space Rocks/libGLESv2.dll",
  `Space Rocks/${SUMS_FILE}`,
];

const LINUX_ENTRIES = [
  "space-rocks/",
  `space-rocks/${README_FILE}`,
  `space-rocks/${NOTICES_FILE}`,
  "space-rocks/assets/",
  "space-rocks/assets/level.json",
  "space-rocks/assets/sprites/",
  "space-rocks/assets/sprites/hero.png",
  "space-rocks/libEGL.so",
  "space-rocks/libGLESv2.so",
  "space-rocks/libvk_swiftshader.so",
  "space-rocks/libvulkan.so.1",
  "space-rocks/space-rocks",
  "space-rocks/vk_swiftshader_icd.json",
  `space-rocks/${SUMS_FILE}`,
];

describe("the archives' layouts", () => {
  it("windows: unzip reads the exe, three DLLs, assets, notices, README and SHA256SUMS, and no game.pdb", {
    skip: !UNZIP,
  }, async () => {
    const r = await rig(BuildTarget.Windows);
    const result = await exportWindowsZip(windowsRequest(r));
    assert.deepEqual(await zipNames(result.archive.file), WINDOWS_ENTRIES);
    assert.deepEqual(result.archive.entries, WINDOWS_ENTRIES);
    assert.equal(result.signed, false);
    assert.equal(result.name, "Space Rocks");
    assert.equal(result.archive.sha256, sha256(await readFile(result.archive.file)));
    assert.deepEqual(await readdir(r.dest), ["Space Rocks-windows-x64.zip"]);
    const game = path.join(await extract(result.archive.file), "Space Rocks");
    assert.deepEqual(await readFile(path.join(game, "Space Rocks.exe")), Buffer.from(GAME_EXE));
    for (const name of Object.values(WindowsAngleDll)) {
      assert.deepEqual(await readFile(path.join(game, name)), Buffer.from(WINDOWS_DLLS[name]), name);
    }
  });

  it("linux: tar reads the game (0755), ANGLE, the Vulkan loader, SwiftShader, assets, notices, README and SHA256SUMS", {
    skip: !TAR,
  }, async () => {
    const r = await rig(BuildTarget.Linux);
    const result = await exportLinuxTarball(linuxRequest(r));
    assert.deepEqual(await tarNames(result.archive.file), LINUX_ENTRIES);
    assert.equal(result.name, "space-rocks");
    const game = path.join(await extract(result.archive.file), "space-rocks");
    const exe = path.join(game, "space-rocks");
    assert.deepEqual(await readFile(exe), LINUX_GAME);
    assert.equal((await lstat(exe)).mode & 0o777, 0o755);
    for (const name of LINUX_HOST_FILES) {
      assert.deepEqual(await readFile(path.join(game, name)), Buffer.from(LINUX_FILES[name]), name);
    }
  });

  it("SHA256SUMS in both archives lists every file beside it, and each digest verifies", {
    skip: !UNZIP || !TAR,
  }, async () => {
    const windows = await rig(BuildTarget.Windows);
    const zip = await exportWindowsZip(windowsRequest(windows));
    const listedZip = await verifySums(path.join(await extract(zip.archive.file), "Space Rocks"));
    const zipFiles = WINDOWS_ENTRIES.filter((name) => !name.endsWith("/") && !name.endsWith(SUMS_FILE));
    assert.deepEqual(
      listedZip,
      zipFiles.map((name) => name.slice("Space Rocks/".length)),
    );
    const linux = await rig(BuildTarget.Linux);
    const tgz = await exportLinuxTarball(linuxRequest(linux));
    const listedTar = await verifySums(path.join(await extract(tgz.archive.file), "space-rocks"));
    const tarFiles = LINUX_ENTRIES.filter((name) => !name.endsWith("/") && !name.endsWith(SUMS_FILE));
    assert.deepEqual(
      listedTar,
      tarFiles.map((name) => name.slice("space-rocks/".length)),
    );
  });

  it("two exports of the same input are byte-identical", async () => {
    const windows = await rig(BuildTarget.Windows);
    const a = await exportWindowsZip(windowsRequest(windows, { archive: path.join(windows.dest, "a.zip") }));
    const b = await exportWindowsZip(windowsRequest(windows, { archive: path.join(windows.dest, "b.zip") }));
    assert.equal(a.archive.sha256, b.archive.sha256);
    const linux = await rig(BuildTarget.Linux);
    const c = await exportLinuxTarball(linuxRequest(linux, { archive: path.join(linux.dest, "c.tgz") }));
    const d = await exportLinuxTarball(linuxRequest(linux, { archive: path.join(linux.dest, "d.tgz") }));
    assert.equal(c.archive.sha256, d.archive.sha256);
  });
});

/** The NOTICES text an export carries. */
async function noticesOf(file: string, folder: string): Promise<string> {
  return readFile(path.join(await extract(file), folder, NOTICES_FILE), "utf8");
}

describe("the licences each destination ships", () => {
  it("windows: mingw-w64 and LLVM runtimes, Zig's runtime, ANGLE, raylib, GLFW, miniaudio and the game's own", {
    skip: !UNZIP,
  }, async () => {
    const r = await rig(BuildTarget.Windows);
    const result = await exportWindowsZip(windowsRequest(r));
    const text = await noticesOf(result.archive.file, "Space Rocks");
    const expected = [
      "the mingw-w64 project",
      "Apache License v2.0 with LLVM Exceptions (libc++)",
      LLVM_LICENCE,
      "Copyright (c) Zig contributors",
      "ANGLE BSD-3-Clause",
      "zlib licence (ANGLE's copy)",
      "raylib is licensed under an unmodified zlib/libpng license",
      "GLFW zlib/libpng licence",
      "ALTERNATIVE 2 - MIT No Attribution",
      "stb: public domain or MIT",
    ];
    for (const fact of expected) assert.ok(text.includes(fact), fact);
    assert.ok(!text.includes(MINIAUDIO_HEADER_CODE), "only miniaudio's licence, not its code");
    assert.ok(!text.includes("SwiftShader") && !text.includes("Kristian"), "nothing Windows does not ship");
    assert.equal(text.split(LLVM_LICENCE).length - 1, 1, "an identical licence text is listed once");
    for (const source of [
      "zig/lib/libc/mingw/COPYING",
      "zig/lib/libcxx/LICENSE.TXT",
      "zig/lib/libcxxabi/LICENSE.TXT",
      "zig/lib/libunwind/LICENSE.TXT",
      "zig/LICENSE",
      "angle/licenses/angle.txt",
      "raylib/src/external/glfw/LICENSE.md",
      "raylib/src/external/miniaudio.h",
      "third_party/stb/LICENSE",
    ]) {
      assert.ok(result.notices.includes(source), source);
    }
  });

  it("linux: ANGLE, SwiftShader and the Wayland protocols, and no mingw-w64", { skip: !TAR }, async () => {
    const r = await rig(BuildTarget.Linux);
    const result = await exportLinuxTarball(linuxRequest(r));
    const text = await noticesOf(result.archive.file, "space-rocks");
    for (const fact of ["ANGLE BSD-3-Clause", "SwiftShader Apache-2.0", WAYLAND_COPYRIGHT, "Copyright (c) Zig"]) {
      assert.ok(text.includes(fact), fact);
    }
    assert.ok(!text.includes("mingw-w64"));
    assert.ok(!text.includes("the header, not compiled code"), "only the compiled protocol code's licences");
    assert.ok(result.notices.includes("linux-sysroot/glfw-wayland/xdg-shell-client-protocol-code.h"));
  });

  it("refuses a licence the store lacks, or a vendored library without one, writing nothing", async () => {
    const rows: Array<[string, (r: Rig) => Promise<void>]> = [
      ["mingw COPYING missing", (r) => rename(path.join(r.zig, "lib/libc/mingw/COPYING"), path.join(r.base, "x"))],
      [
        "GLFW licence missing",
        (r) => rename(path.join(r.raylib, "src/external/glfw/LICENSE.md"), path.join(r.base, "x")),
      ],
      ["third_party/enet without a licence", (r) => writeTree(r.game, { "third_party/enet/enet.h": "/* code */" })],
      ["miniaudio.h without its licence block", (r) => writeTree(r.raylib, { "src/external/miniaudio.h": "/* x */" })],
    ];
    for (const [label, spoil] of rows) {
      const r = await rig(BuildTarget.Windows);
      await spoil(r);
      const before = await facts(r.base);
      await refused(() => exportWindowsZip(windowsRequest(r)), NativeArchiveError, ArchiveRefusal.MissingNotice, label);
      assert.deepEqual(await facts(r.base), before, label);
    }
  });

  it("refuses a store licence or Wayland protocol file that is not its pin, writing nothing", async () => {
    const angleLicence = await rig(BuildTarget.Linux);
    await writeFile(path.join(angleLicence.angle.dir, "licenses/angle.txt"), "edited");
    const wayland = await rig(BuildTarget.Linux);
    await writeFile(path.join(wayland.sysroot.dir, "glfw-wayland/xdg-shell-client-protocol-code.h"), "edited");
    const sysrootPin = await rig(BuildTarget.Linux);
    for (const [label, r, request] of [
      ["ANGLE licence", angleLicence, linuxRequest(angleLicence)],
      ["Wayland protocol code", wayland, linuxRequest(wayland)],
      [
        "sysroot manifest",
        sysrootPin,
        linuxRequest(sysrootPin, { sysroot: { ...sysrootPin.sysroot, manifestSha256: "0".repeat(64) } }),
      ],
    ] as const) {
      const before = await facts(r.base);
      await refused(() => exportLinuxTarball(request), DesktopExportError, DesktopExportProblem.StoreFile, label);
      assert.deepEqual(await facts(r.base), before, label);
    }
  });
});

describe("what the archive takes from the build and the store", () => {
  it("windows: archives the admitted bytes even when out/game.exe changes after admission", {
    skip: !UNZIP,
  }, async () => {
    const r = await rig(BuildTarget.Windows);
    const deps: WindowsExportDeps = {
      admit: async (request) => {
        const admission = await admitCrossOutput(request);
        await writeFile(path.join(r.out, "game.exe"), OTHER_EXE);
        return admission;
      },
    };
    const result = await exportWindowsZip(windowsRequest(r), deps);
    const game = path.join(await extract(result.archive.file), "Space Rocks");
    assert.deepEqual(await readFile(path.join(game, "Space Rocks.exe")), Buffer.from(GAME_EXE));
  });

  it("linux: refuses an executable that changed after admission, writing nothing", async () => {
    const r = await rig(BuildTarget.Linux);
    const before = await facts(r.dest);
    const admit = async (request: Parameters<typeof admitCrossOutput>[0]) => {
      const admission = await admitCrossOutput(request);
      await writeFile(path.join(r.out, "game"), LINUX_OTHER_GAME, { mode: 0o755 });
      return admission;
    };
    await refused(
      () => exportLinuxTarball(linuxRequest(r), { admit }),
      DesktopExportError,
      DesktopExportProblem.Changed,
    );
    assert.deepEqual(await facts(r.dest), before);
  });

  /** Each destination's export, run with `admit` (the real admission, then a change to `out/`). */
  const exportsAfter = (change: (r: Rig) => Promise<void>) =>
    [BuildTarget.Windows, BuildTarget.Linux].map((target) => ({
      target,
      write: async () => {
        const r = await rig(target);
        const admit = async (request: Parameters<typeof admitCrossOutput>[0]) => {
          const admission = await admitCrossOutput(request);
          await change(r);
          return admission;
        };
        const write =
          target === BuildTarget.Windows
            ? () => exportWindowsZip(windowsRequest(r), { admit })
            : () => exportLinuxTarball(linuxRequest(r), { admit });
        return { r, write };
      },
    }));

  it("refuses out/ swapped for a link after admission, reading nothing through it and writing nothing", {
    skip: !POSIX,
  }, async () => {
    const swap = async (r: Rig) => {
      const elsewhere = path.join(r.base, "elsewhere");
      await cp(r.out, elsewhere, { recursive: true });
      await writeFile(path.join(elsewhere, "assets", "level.json"), "SECRET KEY");
      await rename(r.out, path.join(r.base, "out-admitted"));
      await symlink(elsewhere, r.out);
    };
    for (const row of exportsAfter(swap)) {
      const { r, write } = await row.write();
      const error = await refused(write, DesktopExportError, DesktopExportProblem.Changed, row.target);
      assert.equal((error as DesktopExportError).refusal, NativeRefusal.Symlink, row.target);
      assert.deepEqual(await readdir(r.dest), [], row.target);
    }
  });

  it("refuses an asset admission never listed, added after admission, writing nothing", async () => {
    const add = (r: Rig) => writeFile(path.join(r.out, "assets", "late.png"), "late pixels");
    for (const row of exportsAfter(add)) {
      const { r, write } = await row.write();
      const error = await refused(write, DesktopExportError, DesktopExportProblem.Changed, row.target);
      assert.equal((error as DesktopExportError).file, "assets/late.png", row.target);
      assert.deepEqual(await readdir(r.dest), [], row.target);
    }
  });

  it("refuses an asset that became a program after admission, by the bytes it would pack, writing nothing", async () => {
    const programs = { [BuildTarget.Windows]: GAME_EXE, [BuildTarget.Linux]: LINUX_GAME };
    const expected = {
      [BuildTarget.Windows]: NativeRefusal.ExtraPe,
      [BuildTarget.Linux]: NativeRefusal.ExtraSharedObject,
    };
    for (const target of [BuildTarget.Windows, BuildTarget.Linux] as const) {
      const become = (r: Rig) => writeFile(path.join(r.out, "assets", "level.json"), programs[target]);
      const row = exportsAfter(become).find((each) => each.target === target);
      assert.ok(row);
      const { r, write } = await row.write();
      const error = await refused(write, DesktopExportError, DesktopExportProblem.Changed, target);
      assert.equal((error as DesktopExportError).refusal, expected[target], target);
      assert.equal((error as DesktopExportError).file, "assets/level.json", target);
      assert.deepEqual(await readdir(r.dest), [], target);
    }
  });

  it("refuses a build the gate refuses, naming the gate's refusal, writing nothing", async () => {
    const r = await rig(BuildTarget.Windows);
    await writeFile(path.join(r.out, "game.exe"), OPENGL_EXE);
    const before = await facts(r.base);
    const error = await refused(
      () => exportWindowsZip(windowsRequest(r)),
      DesktopExportError,
      DesktopExportProblem.NotAdmitted,
    );
    assert.equal((error as DesktopExportError).refusal, NativeRefusal.ImportsOpengl32);
    assert.deepEqual(await facts(r.base), before);
  });

  it("refuses a store runtime file that differs from its pin, leaving no archive or partial file", async () => {
    const windows = await rig(BuildTarget.Windows);
    await writeFile(path.join(windows.angle.dir, WindowsAngleDll.Gles), WINDOWS_DLLS[WindowsAngleDll.Egl]);
    const linux = await rig(BuildTarget.Linux);
    await writeFile(path.join(linux.angle.dir, "libvk_swiftshader.so"), LINUX_FILES["libEGL.so"]);
    const rows = [
      [windows, () => exportWindowsZip(windowsRequest(windows)), WindowsAngleDll.Gles],
      [linux, () => exportLinuxTarball(linuxRequest(linux)), "libvk_swiftshader.so"],
    ] as const;
    for (const [r, write, file] of rows) {
      const error = await refused(write, DesktopExportError, DesktopExportProblem.StoreFile, file);
      assert.equal((error as DesktopExportError).refusal, NativeRefusal.AngleDigest, file);
      assert.equal((error as DesktopExportError).file, file);
      assert.deepEqual(await readdir(r.dest), [], file);
    }
  });

  it("refuses a known secret in an asset with secret-found, writing nothing", async () => {
    const windows = await rig(BuildTarget.Windows);
    const linux = await rig(BuildTarget.Linux);
    for (const r of [windows, linux]) await writeTree(r.out, { "assets/config.txt": `key=${TOKEN}` });
    const rows = [
      [windows, () => exportWindowsZip(windowsRequest(windows, { secretValues: [TOKEN] }))],
      [linux, () => exportLinuxTarball(linuxRequest(linux, { secretValues: new Set([TOKEN]) }))],
    ] as const;
    for (const [r, write] of rows) {
      const error = await refused(write, NativeArchiveError, ArchiveRefusal.SecretFound);
      assert.ok(!(error as Error).message.includes(TOKEN));
      assert.deepEqual(await readdir(r.dest), []);
    }
  });
});

/** The person's own certificate in a keystore outside the game. */
async function ownCertificate(r: Rig, choice: Partial<OwnCertificateChoice> = {}): Promise<OwnCertificateChoice> {
  const keystore = path.join(r.base, "certs", "me.p12");
  await writeTree(r.base, { "certs/me.p12": "not really pkcs12" });
  return {
    kind: WindowsSigningKind.OwnCertificate,
    storeType: JsignStoreType.Pkcs12,
    keystore,
    alias: "my-key",
    timestampUrl: TIMESTAMP_AUTHORITIES[0],
    password: PASSWORD,
    ...choice,
  };
}

/** `bytes` as jsign leaves them: padded to 8 bytes, a WIN_CERTIFICATE appended, the security directory and checksum set. */
function fakeSigned(bytes: Uint8Array): Buffer {
  const image = Buffer.from(bytes);
  const optional = image.readUInt32LE(0x3c) + 24;
  const plus = image.readUInt16LE(optional) === 0x20b;
  const security = optional + (plus ? 112 : 96) + 4 * 8;
  const padded = Buffer.concat([image, Buffer.alloc((8 - (image.length % 8)) % 8)]);
  const blob = Buffer.from("fake PKCS#7 SignedData");
  const certificate = Buffer.alloc(Math.ceil((8 + blob.length) / 8) * 8);
  certificate.writeUInt32LE(certificate.length, 0);
  certificate.writeUInt16LE(0x0200, 4);
  certificate.writeUInt16LE(0x0002, 6);
  blob.copy(certificate, 8);
  const signed = Buffer.concat([padded, certificate]);
  signed.writeUInt32LE(padded.length, security);
  signed.writeUInt32LE(certificate.length, security + 4);
  signed.writeUInt32LE(0x1234abcd, optional + 64);
  return signed;
}

/** A jsign stand-in: records each run and signs (or spoils) the staged targets as it is told. */
function fakeSigner(
  r: Rig,
  act: (run: JsignRun) => Promise<Partial<JsignRunResult>> = async (signing) => {
    for (const file of signing.targets) await writeFile(file, fakeSigned(await readFile(file)));
    return {};
  },
): { deps: WindowsExportDeps; runs: JsignRun[] } {
  const runs: JsignRun[] = [];
  return {
    runs,
    deps: {
      jsign: {
        tool: { file: "/opt/jsign/bin/jsign", args: [] },
        forbiddenRoots: [r.game, r.out],
        stagingRoot: path.join(r.base, "signing"),
      },
      runSigned: async (signing) => {
        runs.push(signing);
        return { code: 0, stdout: "", stderr: "", timedOut: false, ...(await act(signing)) };
      },
    },
  };
}

describe("signing with the person's own certificate (D20)", () => {
  it("runs jsign in the sandbox on the staged exe and ANGLE DLLs, then zips the signed bytes", {
    skip: !UNZIP,
  }, async () => {
    const r = await rig(BuildTarget.Windows);
    const choice = await ownCertificate(r);
    const archiveFolderWhileSigning: string[][] = [];
    const { deps, runs } = fakeSigner(r, async (signing) => {
      // What an agent writing the exports folder could reach while jsign runs: nothing staged there.
      archiveFolderWhileSigning.push(await readdir(r.dest));
      for (const file of signing.targets) await writeFile(file, fakeSigned(await readFile(file)));
      return {};
    });
    const signing = { requester: SigningRequester.Person, choice };
    const result = await exportWindowsZip(windowsRequest(r, { signing }), deps);
    assert.equal(result.signed, true);
    assert.deepEqual(archiveFolderWhileSigning, [[]], "nothing is staged beside the archive");
    assert.equal(runs.length, 1);
    const [jsign] = runs;
    assert.ok(!jsign.request.command.includes(PASSWORD), "no password in argv");
    assert.deepEqual(jsign.request.env, { [JSIGN_STOREPASS_ENV]: PASSWORD });
    assert.deepEqual(jsign.request.policy?.allowedDomains, ["timestamp.sectigo.com"]);
    assert.deepEqual(jsign.secretValues, [PASSWORD]);
    assert.deepEqual(
      jsign.targets.map((file) => path.basename(file)),
      ["Space Rocks.exe", WindowsAngleDll.Egl, WindowsAngleDll.Gles],
    );
    const stagingRoot = await realpath(path.join(r.base, "signing"));
    assert.equal(
      path.dirname(path.dirname(jsign.targets[0])),
      stagingRoot,
      "staged in the host-private signing folder",
    );
    assert.deepEqual(await readdir(stagingRoot), [], "the staging folder is gone");
    assert.deepEqual(await readdir(r.dest), ["Space Rocks-windows-x64.zip"]);
    const game = path.join(await extract(result.archive.file), "Space Rocks");
    assert.deepEqual(await readFile(path.join(game, "Space Rocks.exe")), fakeSigned(GAME_EXE));
    assert.deepEqual(
      await readFile(path.join(game, WindowsAngleDll.Gles)),
      fakeSigned(WINDOWS_DLLS[WindowsAngleDll.Gles]),
    );
    const d3d = await readFile(path.join(game, WindowsAngleDll.D3dCompiler));
    assert.deepEqual(
      d3d,
      Buffer.from(WINDOWS_DLLS[WindowsAngleDll.D3dCompiler]),
      "Microsoft's compiler is not re-signed",
    );
    assert.match(
      await readFile(path.join(game, README_FILE), "utf8"),
      /signed with its maker's code-signing certificate/,
    );
  });

  it("never spawns jsign for an unsigned export", async () => {
    const r = await rig(BuildTarget.Windows);
    const { deps, runs } = fakeSigner(r);
    const signing = { requester: SigningRequester.Harness, choice: { kind: WindowsSigningKind.Unsigned } } as const;
    const result = await exportWindowsZip(windowsRequest(r, { signing }), deps);
    assert.equal(result.signed, false);
    assert.equal(runs.length, 0);
  });
});

describe("signing refused before anything is staged or spawned", () => {
  it("refuses the harness asking to sign with harness-may-not-sign: nothing staged, nothing spawned", async () => {
    const r = await rig(BuildTarget.Windows);
    const choice = await ownCertificate(r);
    const { deps, runs } = fakeSigner(r);
    const before = await facts(r.base);
    await refused(
      () => exportWindowsZip(windowsRequest(r, { signing: { requester: SigningRequester.Harness, choice } }), deps),
      WindowsSignError,
      WindowsSignProblem.HarnessMayNotSign,
    );
    assert.equal(runs.length, 0);
    assert.deepEqual(await facts(r.base), before);
  });

  it("refuses a key on a token, and signing with no jsign configured, before staging", async () => {
    const rows: Array<[string, Partial<OwnCertificateChoice>, boolean, WindowsSignProblem]> = [
      [
        "token",
        { storeType: JsignStoreType.Yubikey, keystore: null, password: null },
        true,
        WindowsSignProblem.HardwareToken,
      ],
      ["no jsign", {}, false, WindowsSignProblem.Tool],
    ];
    for (const [label, change, configured, code] of rows) {
      const r = await rig(BuildTarget.Windows);
      const choice = await ownCertificate(r, change);
      const { deps, runs } = fakeSigner(r);
      const before = await facts(r.base);
      const signing = { requester: SigningRequester.Person, choice };
      const write = () => exportWindowsZip(windowsRequest(r, { signing }), configured ? deps : {});
      await refused(write, WindowsSignError, code, label);
      assert.equal(runs.length, 0, label);
      assert.deepEqual(await facts(r.base), before, label);
    }
  });

  it("refuses a keystore password when Genex runs on Windows, before staging: the run's env would be a readable file", async () => {
    const r = await rig(BuildTarget.Windows);
    const choice = await ownCertificate(r);
    const { deps, runs } = fakeSigner(r);
    const before = await facts(r.base);
    const signing = { requester: SigningRequester.Person, choice };
    await refused(
      () => exportWindowsZip(windowsRequest(r, { signing, builtOn: StudioPlatform.Windows }), deps),
      WindowsSignError,
      WindowsSignProblem.WindowsHostPassword,
    );
    assert.equal(runs.length, 0);
    assert.deepEqual(await facts(r.base), before);
  });

  it("refuses a staging folder that is a link, before anything is staged", { skip: !POSIX }, async () => {
    const r = await rig(BuildTarget.Windows);
    const choice = await ownCertificate(r);
    const { deps, runs } = fakeSigner(r);
    const elsewhere = path.join(r.base, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(r.base, "signing"));
    const signing = { requester: SigningRequester.Person, choice };
    await refused(
      () => exportWindowsZip(windowsRequest(r, { signing }), deps),
      DesktopExportError,
      DesktopExportProblem.SignFailed,
    );
    assert.equal(runs.length, 0);
    assert.deepEqual(await readdir(elsewhere), []);
    assert.deepEqual(await readdir(r.dest), []);
  });

  it("refuses a failed jsign run without the password in the error, and removes what it staged", async () => {
    const r = await rig(BuildTarget.Windows);
    const choice = await ownCertificate(r);
    const { deps } = fakeSigner(r, async () => ({ code: 1, stderr: `keystore password ${PASSWORD} was incorrect` }));
    const error = await refused(
      () => exportWindowsZip(windowsRequest(r, { signing: { requester: SigningRequester.Person, choice } }), deps),
      DesktopExportError,
      DesktopExportProblem.SignFailed,
    );
    assert.ok(!inspect(error).includes(PASSWORD));
    assert.deepEqual(await readdir(r.dest), []);
  });

  it("refuses signed files that changed more than a signature, and removes what it staged", async () => {
    const rows: Array<[string, (file: string) => Promise<void>]> = [
      [
        "a body byte",
        async (file) => {
          const signed = fakeSigned(await readFile(file));
          signed[0x200] ^= 0xff;
          await writeFile(file, signed);
        },
      ],
      ["another program", async (file) => writeFile(file, fakeSigned(OPENGL_EXE))],
      ["no signature", async () => {}],
    ];
    for (const [label, spoil] of rows) {
      const r = await rig(BuildTarget.Windows);
      const choice = await ownCertificate(r);
      const { deps } = fakeSigner(r, async (signing) => {
        await spoil(signing.targets[0]);
        for (const file of signing.targets.slice(1)) await writeFile(file, fakeSigned(await readFile(file)));
        return {};
      });
      const signing = { requester: SigningRequester.Person, choice };
      await refused(
        () => exportWindowsZip(windowsRequest(r, { signing }), deps),
        DesktopExportError,
        DesktopExportProblem.SignedNotAdmitted,
        label,
      );
      assert.deepEqual(await readdir(r.dest), [], label);
    }
  });
});

describe("hostile archive targets are refused with nothing written", () => {
  /** Each row: a label and the target it names, after setting the rig up. */
  const ROWS: Array<[string, (r: Rig) => Promise<string>, boolean]> = [
    ["a relative path", async () => "Space Rocks-windows-x64.zip", false],
    ["a missing parent folder", async (r) => path.join(r.dest, "missing", "g.archive"), false],
    [
      "a file as the parent",
      async (r) => {
        await writeFile(path.join(r.dest, "file"), "x");
        return path.join(r.dest, "file", "g.archive");
      },
      false,
    ],
    ["a target inside the game folder", async (r) => path.join(r.game, "g.archive"), false],
    ["a target in a game subfolder", async (r) => path.join(r.game, "third_party", "g.archive"), false],
    ["a target inside the build's out/", async (r) => path.join(r.out, "g.archive"), false],
    ["a target named with ../", async (r) => `${r.dest}${path.sep}..${path.sep}dest${path.sep}g.archive`, false],
    [
      "a folder at the target",
      async (r) => {
        await mkdir(path.join(r.dest, "g.archive"));
        return path.join(r.dest, "g.archive");
      },
      false,
    ],
    [
      "a link planted at the target",
      async (r) => {
        await writeTree(r.base, { "outside/victim.txt": "keep me" });
        await symlink(path.join(r.base, "outside", "victim.txt"), path.join(r.dest, "g.archive"));
        return path.join(r.dest, "g.archive");
      },
      true,
    ],
    [
      "a dangling link at the target",
      async (r) => {
        await symlink(path.join(r.base, "nowhere"), path.join(r.dest, "g.archive"));
        return path.join(r.dest, "g.archive");
      },
      true,
    ],
    [
      "a parent that is a link to the game",
      async (r) => {
        await symlink(r.game, path.join(r.dest, "into-game"));
        return path.join(r.dest, "into-game", "g.archive");
      },
      true,
    ],
    [
      "a parent that is a link to a plain folder",
      async (r) => {
        await mkdir(path.join(r.base, "elsewhere"));
        await symlink(path.join(r.base, "elsewhere"), path.join(r.dest, "linked"));
        return path.join(r.dest, "linked", "g.archive");
      },
      true,
    ],
  ];

  for (const target of [BuildTarget.Windows, BuildTarget.Linux] as const) {
    for (const [label, setup, needsLinks] of ROWS) {
      it(`${target}: refuses ${label}`, { skip: needsLinks && !POSIX }, async () => {
        const r = await rig(target);
        const archive = await setup(r);
        const before = await facts(r.base);
        const write =
          target === BuildTarget.Windows
            ? () => exportWindowsZip(windowsRequest(r, { archive }))
            : () => exportLinuxTarball(linuxRequest(r, { archive }));
        await refused(write, DesktopExportError, DesktopExportProblem.Target, label);
        assert.deepEqual(await facts(r.base), before, label);
      });
    }
  }
});

/** The pinned store folder for `id`, as the toolchain manifest pins it. */
function storeFolder(id: ToolchainId, tool: "angleWindows" | "angleLinux" | "linuxSysroot"): CrossAngle {
  const found = devTool(tool);
  const pin = manifestEntry(id, ToolchainHost.MacArm64)?.local?.manifestSha256;
  if ("skip" in found || !pin) throw new Error(`no ${id} folder or pin`);
  return { dir: found.path, manifestSha256: pin };
}

/** A tool's folder, already required by the row. */
function toolPath(name: "zig" | "raylib"): string {
  const found = devTool(name);
  if ("skip" in found) throw new Error(found.skip);
  return name === "zig" ? path.dirname(found.path) : found.path;
}

/**
 * The head start's real package for `target` as a lane `out/` with a small assets folder: cloned
 * (copy-on-write where the disk can) into `base`, so the shared package is never written.
 */
async function realOut(target: typeof BuildTarget.Windows | typeof BuildTarget.Linux, base: string): Promise<string> {
  const found = devCrossPackage(target);
  if ("skip" in found) throw new Error(found.skip);
  const out = path.join(base, "out");
  await cp(found.path, out, { recursive: true, mode: FS.COPYFILE_FICLONE });
  await writeTree(out, { "assets/level.json": '{"tiles":[0,1]}', "assets/sprites/hero.txt": "hero" });
  return out;
}

/** A game folder like the template's: no vendored library yet. */
async function realGame(base: string): Promise<string> {
  const game = path.join(base, "game");
  await writeTree(game, { "third_party/README.md": "Small libraries this game vendors." });
  return game;
}

describe("the head start's real Windows package, exported", () => {
  it("windows: the zig-built starter exports, extracts with unzip, and its tree is admitted again", {
    ...needsTools("angleWindows", "zig", "raylib"),
    ...needsCrossPackage(BuildTarget.Windows),
    ...(UNZIP ? {} : { skip: "not run: no unzip" }),
  }, async () => {
    const base = await tmpDir("desktop-export-real-");
    const dest = path.join(base, "dest");
    await mkdir(dest);
    const angle = storeFolder(ToolchainId.AngleWindows, "angleWindows");
    const request: WindowsExportRequest = {
      title: "game",
      game: await realGame(base),
      out: await realOut(BuildTarget.Windows, base),
      angle,
      zig: toolPath("zig"),
      raylib: toolPath("raylib"),
      archive: path.join(dest, "game-windows-x64.zip"),
      builtOn: StudioPlatform.Mac,
      ranOnTarget: false,
      secretValues: [],
    };
    const result = await exportWindowsZip(request);
    const names = await zipNames(result.archive.file);
    for (const name of ["game/game.exe", "game/libEGL.dll", "game/libGLESv2.dll", "game/d3dcompiler_47.dll"]) {
      assert.ok(names.includes(name), name);
    }
    assert.ok(names.includes("game/assets/sprites/hero.txt"));
    const tree = path.join(await extract(result.archive.file), "game");
    await verifySums(tree);
    const notices = await readFile(path.join(tree, NOTICES_FILE), "utf8");
    for (const fact of [
      "mingw-w64",
      "LLVM Exceptions",
      "Zig contributors",
      "The ANGLE Project Authors",
      "Ramon Santamaria",
      "Camilla Löwy",
      "David Reid",
    ]) {
      assert.ok(notices.includes(fact), fact);
    }
    const again = await admitCrossOutput({ target: BuildTarget.Windows, out: tree, angle });
    assert.ok(again.ok, again.ok ? "" : again.detail);
    const gles = path.join(tree, WindowsAngleDll.Gles);
    const tampered = await readFile(gles);
    tampered[tampered.length - 1] ^= 0xff;
    await writeFile(gles, tampered);
    const refusedAgain = await admitCrossOutput({ target: BuildTarget.Windows, out: tree, angle });
    assert.equal(refusedAgain.ok ? null : refusedAgain.refusal, NativeRefusal.AngleDigest);
  });
});

describe("the head start's real Linux package, exported", () => {
  it("linux: the zig-built starter exports, extracts with tar, and its tree is admitted again", {
    ...needsTools("angleLinux", "linuxSysroot", "zig", "raylib"),
    ...needsCrossPackage(BuildTarget.Linux),
    ...(TAR ? {} : { skip: "not run: no tar" }),
  }, async () => {
    const base = await tmpDir("desktop-export-real-");
    const dest = path.join(base, "dest");
    await mkdir(dest);
    const angle = storeFolder(ToolchainId.AngleLinux, "angleLinux");
    const request: LinuxExportRequest = {
      title: "game",
      game: await realGame(base),
      out: await realOut(BuildTarget.Linux, base),
      angle,
      zig: toolPath("zig"),
      raylib: toolPath("raylib"),
      sysroot: storeFolder(ToolchainId.LinuxSysroot, "linuxSysroot"),
      archive: path.join(dest, "game-linux-x64.tar.gz"),
      builtOn: StudioPlatform.Mac,
      ranOnTarget: false,
      secretValues: [],
    };
    const result = await exportLinuxTarball(request);
    const names = await tarNames(result.archive.file);
    for (const name of ["game/game", ...LINUX_HOST_FILES.map((file) => `game/${file}`), `game/${SUMS_FILE}`]) {
      assert.ok(names.includes(name), name);
    }
    const tree = path.join(await extract(result.archive.file), "game");
    await verifySums(tree);
    const notices = await readFile(path.join(tree, NOTICES_FILE), "utf8");
    for (const fact of ["SwiftShader", "Kristian Høgsberg", "LLVM Exceptions", "Zig contributors"]) {
      assert.ok(notices.includes(fact), fact);
    }
    assert.ok(!notices.includes("mingw-w64"));
    const again = await admitCrossOutput({ target: BuildTarget.Linux, out: tree, angle });
    assert.ok(again.ok, again.ok ? "" : again.detail);
    const swiftshader = path.join(tree, "libvk_swiftshader.so");
    await writeFile(swiftshader, Buffer.concat([await readFile(swiftshader), Buffer.from([0])]));
    const refusedAgain = await admitCrossOutput({ target: BuildTarget.Linux, out: tree, angle });
    assert.equal(refusedAgain.ok, false, "a tampered host file is refused");
  });
});

/** The actual export service over the pinned synthetic store and build output. */
async function service(target: typeof BuildTarget.Windows | typeof BuildTarget.Linux) {
  const r = await rig(target);
  const game: GameProject = {
    name: "space-rocks",
    title: "Space Rocks",
    dir: r.game,
    createdAt: "",
    pathLabel: "",
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    built: true,
    shape: {
      kind: ProjectKind.RaylibCpp,
      entry: "out/game",
      main: "src/main.cpp",
      serve: "out",
      build: null,
      install: null,
      own: true,
    },
    destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web, target] },
  };
  const lock = { version: 1 as const, entries: {}, digest: "e".repeat(64) };
  const builds: unknown[] = [];
  const deps: DesktopExportGameDeps = {
    host: StudioPlatform.Mac,
    games: { list: async () => [game] },
    gameBuilds: raylibLanes({
      ensure: async (input) => {
        builds.push(input);
        return { ok: true, output: r.out, lastGood: r.out, problem: null, ran: true };
      },
    }),
    toolchains: {
      currentLock: async () => lock,
      locate: async () => ({
        ok: true,
        toolchain: {
          lock,
          cmake: "",
          ninja: "",
          emscripten: null,
          genexCmake: {},
          zig: path.join(r.zig, "zig"),
          raylibSource: r.raylib,
          cross: {
            [target]: {
              toolchainFile: "",
              angle: r.angle,
              sysroot: r.sysroot.dir,
              sysrootManifestSha256: r.sysroot.manifestSha256,
            },
          },
        },
      }),
    },
    exportsRoot: r.dest,
    stagingRoot: path.join(r.base, "export-staging"),
    signingRoot: path.join(r.base, "signing"),
    secretValues: () => [TOKEN],
    forbiddenRoots: [r.game],
    secretPaths: [],
    env: {},
    sandboxFor: async () => {
      throw new Error("unsigned exports never spawn jsign");
    },
  };
  const request = {
    game,
    destination: target,
    targetDir: path.join(r.dest, `space-rocks.${target}`),
    signing: { kind: ExportSigning.None },
  };
  return { r, game, deps, request, builds };
}

const refusedExport = (code: ExportRefusal) => (error: unknown) => error instanceof ExportError && error.code === code;

describe("the desktop export service", () => {
  for (const target of [BuildTarget.Windows, BuildTarget.Linux] as const) {
    it(`${target}: builds the current game, stages the archive, replaces its own export and reveals its artifact`, async () => {
      const { deps, request, builds } = await service(target);
      const first = await exportDesktopGame(deps, request);
      assert.equal(first.destination, target);
      assert.equal(path.dirname(first.artifact ?? ""), first.dir);
      assert.ok((await lstat(first.artifact ?? "")).isFile());
      const marker = JSON.parse(await readFile(path.join(first.dir, ".studio-export.json"), "utf8"));
      assert.equal(marker.destination, target);
      const second = await exportDesktopGame(deps, request);
      assert.equal(second.artifact, first.artifact);
      assert.equal(builds.length, 2);
      assert.equal((builds[0] as { purpose: string }).purpose, "export");
    });
  }
  it("ignores a forged game's destinations and refuses before building or writing", async () => {
    const { r, game, deps, request, builds } = await service(BuildTarget.Windows);
    game.destinations = { stack: GameStack.RaylibCpp, targets: [BuildTarget.Web] };
    const before = await facts(r.base);
    const forged = { ...game, destinations: { stack: GameStack.RaylibCpp, targets: [BuildTarget.Windows] } };
    await assert.rejects(
      exportDesktopGame(deps, { ...request, game: forged }),
      refusedExport(ExportRefusal.NotADestination),
    );
    assert.equal(builds.length, 0);
    assert.deepEqual(await facts(r.base), before);
  });
  it("refuses a foreign export folder and a symlink escaping the exports root", { skip: !POSIX }, async () => {
    const { r, deps, request } = await service(BuildTarget.Windows);
    await mkdir(request.targetDir);
    await writeFile(path.join(request.targetDir, "owner.txt"), "preserve me");
    await assert.rejects(exportDesktopGame(deps, request), refusedExport(ExportRefusal.NotAnExportFolder));
    assert.equal(await readFile(path.join(request.targetDir, "owner.txt"), "utf8"), "preserve me");
    const link = path.join(r.dest, "escape");
    await symlink(r.game, link);
    await assert.rejects(
      exportDesktopGame(deps, { ...request, targetDir: path.join(link, "new") }),
      refusedExport(ExportRefusal.TargetRefused),
    );
    assert.equal(await lstat(path.join(r.game, "new")).catch(() => null), null);
  });
  it("refuses missing signing tooling before the build, and never lets a harness sign", async () => {
    const { deps, request, builds } = await service(BuildTarget.Windows);
    const signing = {
      kind: ExportSigning.OwnCertificate,
      storeType: JsignStoreType.Pkcs12,
      keystore: "/person/key.p12",
      alias: "key",
      timestampUrl: TIMESTAMP_AUTHORITIES[0],
      password: null,
    };
    await assert.rejects(
      exportDesktopGame(deps, { ...request, signing, person: true }),
      refusedExport(ExportRefusal.SigningUnavailable),
    );
    await assert.rejects(
      exportDesktopGame(deps, { ...request, signing }),
      refusedExport(ExportRefusal.HarnessMayNotSign),
    );
    assert.equal(builds.length, 0);
  });
  it("the certificate signer gets its own sandbox and proxy, disposes it, and redacts failures", async () => {
    const { r, deps, request } = await service(BuildTarget.Windows);
    const keystore = path.join(r.base, "person.p12");
    const launcher = path.join(r.base, "jsign");
    await writeFile(keystore, "fixture certificate");
    await writeFile(launcher, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    deps.env = { GENEX_EXPORT_JSIGN: launcher };
    let disposed = false;
    deps.sandboxFor = async (options) => {
      assert.equal(options.writableRoots.length, 1);
      assert.ok(options.writableRoots[0]?.startsWith(await realpath(deps.signingRoot)));
      assert.ok(options.denyWrite?.includes(r.game));
      return {
        networkProxy: () => ({ host: "127.0.0.1", port: 18080 }),
        dispose: async () => {
          disposed = true;
        },
        run: async (run) => {
          assert.equal(run.env?.GENEX_JSIGN_STOREPASS, PASSWORD);
          assert.match(run.env?.JAVA_TOOL_OPTIONS ?? "", /-Dhttps.proxyPort=18080/);
          assert.doesNotMatch(run.command, new RegExp(PASSWORD));
          return {
            command: run.command,
            cwd: run.cwd,
            code: 1,
            stdout: PASSWORD,
            stderr: PASSWORD,
            signal: null,
            durationMs: 1,
            timedOut: false,
            truncated: false,
            sandboxed: true,
          };
        },
      };
    };
    const signing = {
      kind: ExportSigning.OwnCertificate,
      storeType: JsignStoreType.Pkcs12,
      keystore,
      alias: "key",
      timestampUrl: TIMESTAMP_AUTHORITIES[0],
      password: PASSWORD,
    };
    await assert.rejects(exportDesktopGame(deps, { ...request, signing, person: true }), (error) => {
      assert.ok(error instanceof ExportError);
      assert.equal(error.code, ExportRefusal.SigningFailed);
      assert.doesNotMatch(error.message, new RegExp(PASSWORD));
      return true;
    });
    assert.equal(disposed, true);
    assert.deepEqual(await readdir(deps.signingRoot), []);
    assert.deepEqual(await readdir(deps.stagingRoot), []);
  });
  it("preserves typed gate details and rethrows unknown failures unchanged", () => {
    const gate = new DesktopExportError(DesktopExportProblem.NotAdmitted, "refused", {
      refusal: NativeRefusal.LinksOpenGl,
      file: "game.exe",
    });
    const mapped = exportRefusalOf(gate);
    assert.equal(mapped.code, ExportRefusal.AdmissionRefused);
    assert.equal(mapped.refusal, NativeRefusal.LinksOpenGl);
    assert.equal(mapped.file, "game.exe");
    const unknown = new Error("disk disappeared");
    assert.throws(
      () => exportRefusalOf(unknown),
      (error) => error === unknown,
    );
  });
});

// ---------- a Rust · wgpu game's Windows export (M4.1) ----------

/** The Rust game's build as the lane leaves it: `game.exe` (a real link set) and its assets. */
const RUST_EXE = windowsBinary();
const RUST_ASSETS = { "assets/fish.txt": "fish", "assets/levels/one.json": '{"pond":1}' };

/** Two notices as `rustNotices` writes them: the crate list (host text) and a runtime licence file. */
async function rustNoticesIn(base: string): Promise<MacNotice[]> {
  const licence = path.join(base, "store", "llvm-mingw", "LICENSE.TXT");
  await writeTree(path.dirname(licence), { "LICENSE.TXT": LLVM_LICENCE });
  return [
    {
      folder: "rust-crates",
      title: "Rust crates the game links",
      sources: [{ kind: NoticeSourceKind.Text, name: "CRATES.txt", text: "wgpu 30.0.1: MIT OR Apache-2.0\n" }],
    },
    {
      folder: "rust-runtime/libunwind",
      title: "LLVM libunwind: Apache-2.0 WITH LLVM-exception",
      sources: [{ kind: NoticeSourceKind.File, path: licence }],
    },
  ];
}

/** A Rust rig as the signing helpers read a rig: its base, game and out/ (no store). */
const NO_STORE: CrossAngle = { dir: "", manifestSha256: "" };
const signingRig = (r: RustRig): Rig => ({ ...r, angle: NO_STORE, zig: "", raylib: "", sysroot: NO_STORE });

interface RustRig {
  base: string;
  game: string;
  out: string;
  dest: string;
  notices: MacNotice[];
}

/** A Rust game, its lane `out/` and an empty destination folder. */
async function rustRig(exe: Uint8Array = RUST_EXE): Promise<RustRig> {
  const base = await realpath(await tmpDir("rust-windows-export-"));
  const game = path.join(base, "game");
  await writeTree(game, { "genex.toml": '[game]\ntitle = "Pond"\n', "src/main.rs": "fn main() {}" });
  const out = path.join(base, "rust-builds", "pond-0123", "windows-0123.out");
  await writeTree(out, { "game.exe": exe, ...RUST_ASSETS });
  const dest = path.join(base, "dest");
  await mkdir(dest);
  return { base, game, out, dest, notices: await rustNoticesIn(base) };
}

/** The receipt's `outputs` for `out/` as it is now: every file's digest. */
async function outputsOf(out: string): Promise<RustWindowsExportRequest["outputs"]> {
  const files = (await readdir(out, { recursive: true })).sort();
  const outputs: Array<{ path: string; sha256: string }> = [];
  for (const rel of files) {
    const at = path.join(out, rel);
    if ((await lstat(at)).isFile())
      outputs.push({ path: rel.split(path.sep).join("/"), sha256: sha256(await readFile(at)) });
  }
  return outputs;
}

async function rustRequest(
  r: RustRig,
  overrides: Partial<RustWindowsExportRequest> = {},
): Promise<RustWindowsExportRequest> {
  return {
    title: "Pond",
    game: r.game,
    out: r.out,
    outputs: await outputsOf(r.out),
    notices: r.notices,
    archive: path.join(r.dest, "Pond-windows-x64.zip"),
    builtOn: StudioPlatform.Mac,
    secretValues: [TOKEN],
    ...overrides,
  };
}

describe("a Rust game's Windows export (M4.1)", () => {
  it("packs the admitted game.exe alone with its assets, notices, README and sums, and records untested", {
    skip: !UNZIP,
  }, async () => {
    const r = await rustRig();
    const result = await exportRustWindowsZip(await rustRequest(r));
    assert.equal(result.gpuQualification, GpuQualification.Untested);
    assert.equal(result.signed, false);
    assert.equal(result.name, "Pond");
    const names = await zipNames(result.archive.file);
    assert.deepEqual(names, [
      "Pond/",
      "Pond/Pond.exe",
      "Pond/README.txt",
      "Pond/THIRD-PARTY-NOTICES.txt",
      "Pond/assets/",
      "Pond/assets/fish.txt",
      "Pond/assets/levels/",
      "Pond/assets/levels/one.json",
      "Pond/notices/",
      "Pond/notices/rust-crates/",
      "Pond/notices/rust-crates/CRATES.txt",
      "Pond/notices/rust-runtime/",
      "Pond/notices/rust-runtime/libunwind/",
      "Pond/notices/rust-runtime/libunwind/LICENSE.TXT",
      "Pond/SHA256SUMS",
    ]);
    assert.ok(!names.some((name) => name.toLowerCase().endsWith(".dll")), "no DLL ships beside a Rust game");
    const folder = path.join(await extract(result.archive.file), "Pond");
    assert.deepEqual(await readFile(path.join(folder, "Pond.exe")), Buffer.from(RUST_EXE));
    assert.equal((await verifySums(folder)).length, 7, "every file beside the sums");
    const readme = await readFile(path.join(folder, README_FILE), "utf8");
    assert.match(readme, /DirectX 12/);
    assert.match(readme, /software renderer \(WARP\), never on a real graphics card/);
    assert.ok(readme.includes("\r\n"), "Windows line ends");
    const index = await readFile(path.join(folder, NOTICES_FILE), "utf8");
    assert.match(index, /LLVM libunwind/);
    assert.match(index, /rust-runtime\/libunwind\/LICENSE\.TXT/);
    assert.equal(
      await readFile(path.join(folder, NOTICES_FOLDER, "rust-runtime", "libunwind", "LICENSE.TXT"), "utf8"),
      LLVM_LICENCE,
    );
  });

  it("gives byte-identical zips for the same build, exported twice or from a second identical build", async () => {
    const r = await rustRig();
    const first = await exportRustWindowsZip(await rustRequest(r));
    const again = await exportRustWindowsZip(await rustRequest(r, { archive: path.join(r.dest, "again.zip") }));
    const other = await rustRig();
    const second = await exportRustWindowsZip(await rustRequest(other));
    const bytes = await readFile(first.archive.file);
    assert.equal(sha256(await readFile(again.archive.file)), sha256(bytes));
    assert.equal(sha256(await readFile(second.archive.file)), sha256(bytes));
    assert.equal(first.archive.sha256, sha256(bytes));
  });

  const hostileExes: Array<[string, Uint8Array, NativeRefusal]> = [
    ["desktop OpenGL", windowsBinary({ imports: ["kernel32.dll", "opengl32.dll"] }), NativeRefusal.ImportsOpengl32],
    ["the DXC compiler", windowsBinary({ imports: ["kernel32.dll", "dxcompiler.dll"] }), NativeRefusal.ForeignImport],
    ["DXIL, delay-loaded", windowsBinary({ delayImports: ["dxil.dll"] }), NativeRefusal.ForeignImport],
    ["the Vulkan loader", windowsBinary({ imports: ["kernel32.dll", "vulkan-1.dll"] }), NativeRefusal.ForeignImport],
    ["the studio transport", windowsBinary({ trailer: "GENEX_STUDIO_PIPE" }), NativeRefusal.NotAnExecutable],
  ];
  for (const [label, exe, refusal] of hostileExes) {
    it(`refuses an exe importing ${label} as not-admitted (${refusal}), with nothing written`, async () => {
      const r = await rustRig(exe);
      const error = await refused(
        async () => exportRustWindowsZip(await rustRequest(r)),
        DesktopExportError,
        DesktopExportProblem.NotAdmitted,
        label,
      );
      assert.equal((error as DesktopExportError).refusal, refusal);
      assert.equal((error as DesktopExportError).file, "game.exe");
      assert.deepEqual(await readdir(r.dest), []);
    });
  }

  const late: Array<[string, (r: RustRig) => Promise<void>, string]> = [
    [
      "an exe swapped after the lane admitted it",
      async (r) => writeFile(path.join(r.out, "game.exe"), windowsBinary({ imports: ["kernel32.dll", "user32.dll"] })),
      "game.exe",
    ],
    [
      "an asset the lane never admitted",
      async (r) => writeFile(path.join(r.out, "assets", "extra.txt"), "late"),
      "assets/extra.txt",
    ],
    [
      "an asset rewritten after admission",
      async (r) => writeFile(path.join(r.out, "assets", "fish.txt"), "carp"),
      "assets/fish.txt",
    ],
  ];
  for (const [label, act, file] of late) {
    it(`refuses ${label} as changed, with nothing written`, async () => {
      const r = await rustRig();
      const request = await rustRequest(r);
      await act(r);
      const error = await refused(
        async () => exportRustWindowsZip(request),
        DesktopExportError,
        DesktopExportProblem.Changed,
        label,
      );
      assert.equal((error as DesktopExportError).file, file);
      assert.deepEqual(await readdir(r.dest), []);
    });
  }

  it("refuses an admitted asset that starts as a Windows program", async () => {
    const r = await rustRig();
    await writeFile(path.join(r.out, "assets", "fish.txt"), RUST_EXE);
    const error = await refused(
      async () => exportRustWindowsZip(await rustRequest(r)),
      DesktopExportError,
      DesktopExportProblem.Changed,
    );
    assert.equal((error as DesktopExportError).refusal, NativeRefusal.ExtraPe);
    assert.deepEqual(await readdir(r.dest), []);
  });

  it("refuses a held credential in an asset", async () => {
    const r = await rustRig();
    await writeFile(path.join(r.out, "assets", "fish.txt"), `key=${TOKEN}`);
    await refused(
      async () => exportRustWindowsZip(await rustRequest(r)),
      NativeArchiveError,
      ArchiveRefusal.SecretFound,
    );
    assert.deepEqual(await readdir(r.dest), []);
  });

  it("signs game.exe alone with the person's own certificate and zips the signed bytes", { skip: !UNZIP }, async () => {
    const r = await rustRig();
    const choice = await ownCertificate(signingRig(r));
    const { deps, runs } = fakeSigner(signingRig(r));
    const signing = { requester: SigningRequester.Person, choice };
    const result = await exportRustWindowsZip(await rustRequest(r, { signing }), deps);
    assert.equal(result.signed, true);
    assert.equal(runs.length, 1);
    assert.deepEqual(
      runs[0]?.targets.map((file) => path.basename(file)),
      ["Pond.exe"],
      "only the game is signed",
    );
    const folder = path.join(await extract(result.archive.file), "Pond");
    assert.deepEqual(await readFile(path.join(folder, "Pond.exe")), fakeSigned(RUST_EXE));
    assert.match(
      await readFile(path.join(folder, README_FILE), "utf8"),
      /signed with its maker's code-signing certificate/,
    );
    assert.deepEqual(await readdir(await realpath(path.join(r.base, "signing"))), [], "the staging folder is gone");
  });

  it("refuses a signed exe that changed more than its signature, and writes nothing", async () => {
    const r = await rustRig();
    const asRig = signingRig(r);
    const choice = await ownCertificate(asRig);
    const { deps } = fakeSigner(asRig, async (signing) => {
      for (const file of signing.targets)
        await writeFile(file, Buffer.concat([fakeSigned(await readFile(file)), Buffer.from("x")]));
      return {};
    });
    const signing = { requester: SigningRequester.Person, choice };
    await refused(
      async () => exportRustWindowsZip(await rustRequest(r, { signing }), deps),
      DesktopExportError,
      DesktopExportProblem.SignedNotAdmitted,
    );
    assert.deepEqual(await readdir(r.dest), []);
  });
});
