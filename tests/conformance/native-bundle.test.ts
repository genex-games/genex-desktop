/**
 * Admission of a Mac build of a C++ · raylib game, and the run directory it starts from. A build's
 * `out/` is agent-made, so the host reads the executable's Mach-O load commands itself and refuses,
 * by a typed `NativeRefusal`, anything that is not one plain thin-arm64 executable importing the
 * store's ANGLE through `@executable_path/../Frameworks` and nothing of Apple's OpenGL. The pure rows
 * build their images with `tests/helpers/macho.ts` and run on every platform; the darwin rows build
 * real programs with clang, assemble them with the real `codesign`, and start one under the game
 * profile.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  MAC_ANGLE_IMPORTS,
  MAC_GAME_RPATH,
  NATIVE_BUNDLE_APP,
  NativeError,
  NativeRefusal,
  NativeRunMode,
  RustAdmissionProblem,
} from "../../src/shared/native-contract.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { ToolchainHost, ToolchainId } from "../../src/shared/toolchain.ts";
import {
  type AdmittedMacBundle,
  admitMacBundle,
  admitRustMachO,
  admitWgpuBundle,
  assembleRunDir,
  assembleWgpuRunDir,
  type BundleExec,
  checkMacAngle,
  type MacAngle,
  MachOFileType,
  parseMachO,
  readMachO,
  removeRunDir,
} from "../../src/substrate/native-bundle.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { entryDigest, manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { devTool } from "../helpers/dev-toolchains.ts";
import {
  CPU_X86_64,
  dylib,
  FAT_MAGIC,
  FAT_MAGIC_64,
  fat,
  gameCommands,
  LoadCommand,
  loadCommand,
  MachOFile,
  macClang,
  macClangSkip,
  machO,
} from "../helpers/macho.ts";
import { admittedReport } from "../helpers/rust-admitted.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";
import { ApplePlatform, iosBinary, iosSimulatorBinary, M2, macBinary } from "../fixtures/rust-bundles/binaries.ts";

const execFileAsync = promisify(execFile);
const POSIX = process.platform === "win32" && "POSIX links, FIFOs and modes";

const OPENGL = "/System/Library/Frameworks/OpenGL.framework/Versions/A/OpenGL";
const GOOD_GAME = () => machO({ commands: gameCommands() });
const BUNDLE_ID = "games.genex.game.0123456789ab";
const RUN_ID = "0123456789abcdef";

const refusal = (error: unknown) => (error instanceof NativeError ? error.refusal : String(error));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A lane output folder: `game` and `game-headless` (the same image unless named), plus `assets/`. */
async function outWith(
  base: string,
  files: { game?: Buffer; headless?: Buffer; assets?: Record<string, Buffer | string> } = {},
) {
  const out = path.join(base, "out");
  await mkdir(path.join(out, "assets"), { recursive: true });
  await writeFile(path.join(out, "game"), files.game ?? GOOD_GAME(), { mode: 0o755 });
  await writeFile(path.join(out, "game-headless"), files.headless ?? files.game ?? GOOD_GAME(), { mode: 0o755 });
  for (const [rel, bytes] of Object.entries(files.assets ?? { "sprites/ship.png": "png bytes" })) {
    await mkdir(path.dirname(path.join(out, "assets", rel)), { recursive: true });
    await writeFile(path.join(out, "assets", rel), bytes);
  }
  return out;
}

/** A store ANGLE folder: the two libraries and a manifest.json naming their digests and sizes. */
async function storeWith(base: string, libraries: { egl?: Buffer; gles?: Buffer } = {}): Promise<MacAngle> {
  const dir = path.join(base, "angle-store");
  await mkdir(dir, { recursive: true });
  const egl =
    libraries.egl ?? dylib("@rpath/libEGL.dylib", ["/System/Library/Frameworks/Metal.framework/Versions/A/Metal"]);
  const gles =
    libraries.gles ??
    dylib("@rpath/libGLESv2.dylib", ["/System/Library/Frameworks/IOSurface.framework/Versions/A/IOSurface"]);
  await writeFile(path.join(dir, "libEGL.dylib"), egl);
  await writeFile(path.join(dir, "libGLESv2.dylib"), gles);
  const manifest = JSON.stringify({
    schema: 1,
    files: {
      "libEGL.dylib": { sha256: sha256(egl), size: egl.length },
      "libGLESv2.dylib": { sha256: sha256(gles), size: gles.length },
    },
  });
  await writeFile(path.join(dir, "manifest.json"), manifest);
  return {
    dir,
    egl: path.join(dir, "libEGL.dylib"),
    gles: path.join(dir, "libGLESv2.dylib"),
    manifestSha256: sha256(Buffer.from(manifest)),
  };
}

/** Every entry under `dir`: a link's target, a file's digest and mode, a folder's mode. */
async function tree(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const listed: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const info = await lstat(full);
    const rel = path.relative(dir, full);
    if (info.isSymbolicLink()) listed.push(`${rel} -> ${await readlink(full)}`);
    else if (info.isFile()) listed.push(`${rel} ${sha256(await readFile(full))} ${(info.mode & 0o777).toString(8)}`);
    else listed.push(`${rel}/ ${(info.mode & 0o777).toString(8)}`);
  }
  return listed.sort();
}

/** A codesign stand-in that records each call and signs nothing. */
function fakeExec(code = 0): { exec: BundleExec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return { code, stdout: "", stderr: code ? "codesign failed" : "" };
    },
  };
}

/** A fresh base folder whose run dirs are removed (bundles are read-only) before the temp folder goes. */
async function workspace(prefix: string) {
  const base = await tmpDir(prefix);
  const runs = path.join(base, "native-runs");
  closeBeforeCleanup(async () => {
    for (const name of existsSync(runs) ? await readdir(runs) : []) await removeRunDir(path.join(runs, name));
  });
  return { base, runs };
}

async function admitted(out: string, mode: NativeRunMode = NativeRunMode.Headless): Promise<AdmittedMacBundle> {
  const admission = await admitMacBundle(out, { mode });
  assert.ok(admission.ok, admission.ok ? "" : `${admission.refusal}: ${admission.detail}`);
  return admission.bundle;
}

describe("the Mach-O reader", () => {
  it("reads a thin arm64 executable's imports and rpaths, and a library's id", () => {
    const image = parseMachO(
      machO({
        commands: [
          ...gameCommands(),
          { cmd: LoadCommand.LoadWeakDylib, value: "/usr/lib/libweak.dylib" },
          { cmd: LoadCommand.ReexportDylib, value: "/usr/lib/libre.dylib" },
          { cmd: LoadCommand.LazyLoadDylib, value: "/usr/lib/liblazy.dylib" },
          { cmd: LoadCommand.LoadUpwardDylib, value: "/usr/lib/libup.dylib" },
        ],
      }),
    );
    assert.deepEqual(image, {
      fileType: MachOFileType.Execute,
      dylibs: [
        ...MAC_ANGLE_IMPORTS,
        "/System/Library/Frameworks/Metal.framework/Versions/A/Metal",
        "/usr/lib/libSystem.B.dylib",
        "/usr/lib/libweak.dylib",
        "/usr/lib/libre.dylib",
        "/usr/lib/liblazy.dylib",
        "/usr/lib/libup.dylib",
      ],
      rpaths: [MAC_GAME_RPATH],
      id: null,
      environment: [],
    });
    const library = parseMachO(dylib("@rpath/libEGL.dylib"));
    assert.equal(library.fileType, MachOFileType.Dylib);
    assert.equal(library.id, "@rpath/libEGL.dylib");
  });

  const good = GOOD_GAME();
  const [first = Buffer.alloc(0)] = gameCommands().map((command) => loadCommand(command));
  const hostile: Array<[string, Buffer]> = [
    ["an empty file", Buffer.alloc(0)],
    ["a header cut short", good.subarray(0, 16)],
    ["load commands cut short", good.subarray(0, good.length - 8)],
    [
      "a string offset past its command",
      machO({}, [loadCommand(gameCommands()[0] ?? { cmd: LoadCommand.LoadDylib, value: "x" }, { stringOffset: 4096 })]),
    ],
    [
      "a string offset inside the command's fixed part",
      machO({}, [loadCommand({ cmd: LoadCommand.LoadDylib, value: "x" }, { stringOffset: 8 })]),
    ],
    [
      "a string with no NUL before its command ends",
      machO({}, [Buffer.concat([first.subarray(0, first.length - 8), Buffer.alloc(8, 0x41)])]),
    ],
    ["more commands than the bytes hold", machO({ commands: gameCommands(), ncmds: 1000 })],
    ["a command count that overflows", machO({ commands: gameCommands(), ncmds: 0xffffffff })],
    ["a zero-sized command", machO({}, [Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0])])],
    [
      "a command size not a multiple of 8",
      machO({}, [Buffer.concat([Buffer.from([0x0c, 0, 0, 0, 12, 0, 0, 0, 24, 0, 0, 0])])]),
    ],
    ["an x86_64 image", machO({ cpuType: CPU_X86_64, commands: gameCommands() })],
    ["a loadable bundle", machO({ fileType: MachOFile.Bundle, commands: gameCommands() })],
    ["a 32-bit header", Buffer.from([0xce, 0xfa, 0xed, 0xfe, ...good.subarray(4)])],
    ["a fat file", fat([good])],
    ["a 64-bit fat file", fat([good], FAT_MAGIC_64)],
    [
      "invalid UTF-8 in an install name",
      machO({}, [
        Buffer.from(
          loadCommand({ cmd: LoadCommand.LoadDylib, value: "/usr/lib/ÿ" }).map((byte) => (byte === 0xc3 ? 0xff : byte)),
        ),
      ]),
    ],
    ["a shell script", Buffer.from("#!/bin/sh\nexec /usr/bin/true\n")],
  ];
  for (const [name, bytes] of hostile) {
    it(`refuses ${name} as not-an-executable`, () => {
      assert.throws(
        () => parseMachO(bytes),
        (error: unknown) => refusal(error) === NativeRefusal.NotAnExecutable,
      );
    });
  }

  it("refuses both fat magics by their big-endian spelling", () => {
    for (const magic of [FAT_MAGIC, FAT_MAGIC_64]) {
      const bytes = Buffer.alloc(64);
      bytes.writeUInt32BE(magic, 0);
      assert.throws(
        () => parseMachO(bytes),
        (error: unknown) => refusal(error) === NativeRefusal.NotAnExecutable,
      );
    }
  });

  it("reads a file without following a link, without blocking on a FIFO, and within a cap", {
    skip: POSIX,
  }, async () => {
    const base = await tmpDir("macho-read-");
    const file = path.join(base, "game");
    await writeFile(file, GOOD_GAME());
    assert.deepEqual((await readMachO(file)).rpaths, [MAC_GAME_RPATH]);
    await symlink(file, path.join(base, "linked"));
    await assert.rejects(
      readMachO(path.join(base, "linked")),
      (error: unknown) => refusal(error) === NativeRefusal.Symlink,
    );
    await execFileAsync("mkfifo", [path.join(base, "fifo")]);
    await assert.rejects(
      readMachO(path.join(base, "fifo")),
      (error: unknown) => refusal(error) === NativeRefusal.NotAnExecutable,
    );
    await assert.rejects(readMachO(file, 64), (error: unknown) => refusal(error) === NativeRefusal.NotAnExecutable);
  });
});

describe("admitMacBundle", { skip: POSIX }, () => {
  /** One row per refusal: how its `out/` is made, the mode admitted and the code expected. */
  const rows: Array<{
    name: string;
    refusal: NativeRefusal;
    mode?: NativeRunMode;
    make(base: string): Promise<string>;
  }> = [
    {
      name: "the executable is a link",
      refusal: NativeRefusal.Symlink,
      async make(base) {
        const out = await outWith(base);
        await writeFile(path.join(base, "elsewhere"), GOOD_GAME());
        await rm(path.join(out, "game-headless"));
        await symlink(path.join(base, "elsewhere"), path.join(out, "game-headless"));
        return out;
      },
    },
    {
      name: "an asset is a link",
      refusal: NativeRefusal.Symlink,
      async make(base) {
        const out = await outWith(base);
        await symlink("/etc/hosts", path.join(out, "assets", "sprites", "hosts.png"));
        return out;
      },
    },
    {
      name: "the assets folder is a link",
      refusal: NativeRefusal.Symlink,
      async make(base) {
        const out = await outWith(base);
        await rm(path.join(out, "assets"), { recursive: true });
        await symlink(base, path.join(out, "assets"));
        return out;
      },
    },
    {
      name: "the executable has a second hard link",
      refusal: NativeRefusal.HardLink,
      async make(base) {
        const out = await outWith(base);
        await link(path.join(out, "game-headless"), path.join(base, "kept-link"));
        return out;
      },
    },
    {
      name: "an asset has a second hard link",
      refusal: NativeRefusal.HardLink,
      async make(base) {
        const out = await outWith(base);
        await link(path.join(out, "assets", "sprites", "ship.png"), path.join(base, "kept-asset-link"));
        return out;
      },
    },
    {
      name: "the executable is a shell script",
      refusal: NativeRefusal.NotAnExecutable,
      async make(base) {
        return outWith(base, { game: Buffer.from("#!/bin/sh\n") });
      },
    },
    {
      name: "the executable is missing",
      refusal: NativeRefusal.NotAnExecutable,
      async make(base) {
        const out = await outWith(base);
        await rm(path.join(out, "game-headless"));
        return out;
      },
    },
    {
      name: "the executable is a FIFO",
      refusal: NativeRefusal.NotAnExecutable,
      async make(base) {
        const out = await outWith(base);
        await rm(path.join(out, "game-headless"));
        await execFileAsync("mkfifo", [path.join(out, "game-headless")]);
        return out;
      },
    },
    {
      name: "the executable is a library",
      refusal: NativeRefusal.NotAnExecutable,
      async make(base) {
        return outWith(base, { game: dylib("@rpath/game.dylib", [...MAC_ANGLE_IMPORTS]) });
      },
    },
    {
      name: "the executable is fat",
      refusal: NativeRefusal.NotAnExecutable,
      async make(base) {
        return outWith(base, { game: fat([GOOD_GAME()]) });
      },
    },
    {
      name: "it imports OpenGL.framework",
      refusal: NativeRefusal.LinksOpenGl,
      async make(base) {
        return outWith(base, { game: machO({ commands: gameCommands({ dylibs: [...MAC_ANGLE_IMPORTS, OPENGL] }) }) });
      },
    },
    {
      name: "it imports OpenGL.framework weakly, in another case",
      refusal: NativeRefusal.LinksOpenGl,
      async make(base) {
        const commands = [
          ...gameCommands(),
          { cmd: LoadCommand.LoadWeakDylib, value: "/System/Library/Frameworks/opengl.framework/OpenGL" },
        ];
        return outWith(base, { game: machO({ commands }) });
      },
    },
    {
      name: "it imports a libGL",
      refusal: NativeRefusal.LinksOpenGl,
      async make(base) {
        return outWith(base, {
          game: machO({ commands: gameCommands({ dylibs: [...MAC_ANGLE_IMPORTS, "/opt/X11/lib/libGL.1.dylib"] }) }),
        });
      },
    },
    {
      name: "it imports libEGL only",
      refusal: NativeRefusal.MissingAngleImport,
      async make(base) {
        return outWith(base, { game: machO({ commands: gameCommands({ dylibs: ["@rpath/libEGL.dylib"] }) }) });
      },
    },
    {
      name: "it imports libGLESv2 by a path of its own",
      refusal: NativeRefusal.MissingAngleImport,
      async make(base) {
        const dylibs = ["@rpath/libEGL.dylib", "@executable_path/../Frameworks/libGLESv2.dylib"];
        return outWith(base, { game: machO({ commands: gameCommands({ dylibs }) }) });
      },
    },
    {
      name: "it carries no rpath",
      refusal: NativeRefusal.ForeignRpath,
      async make(base) {
        return outWith(base, { game: machO({ commands: gameCommands({ rpaths: [] }) }) });
      },
    },
    {
      name: "it carries an rpath of its own",
      refusal: NativeRefusal.ForeignRpath,
      async make(base) {
        return outWith(base, { game: machO({ commands: gameCommands({ rpaths: ["/usr/local/lib"] }) }) });
      },
    },
    {
      name: "it carries a second rpath",
      refusal: NativeRefusal.ForeignRpath,
      async make(base) {
        return outWith(base, {
          game: machO({ commands: gameCommands({ rpaths: [MAC_GAME_RPATH, "@loader_path/../Resources/assets"] }) }),
        });
      },
    },
    {
      name: "it sets a dyld search path for itself",
      refusal: NativeRefusal.ForeignRpath,
      async make(base) {
        const commands = [
          ...gameCommands(),
          { cmd: LoadCommand.DyldEnvironment, value: "DYLD_LIBRARY_PATH=/usr/local/lib" },
        ];
        return outWith(base, { game: machO({ commands }) });
      },
    },
    {
      name: "an asset is a Mach-O executable",
      refusal: NativeRefusal.ExtraMachO,
      async make(base) {
        return outWith(base, { assets: { "levels/level1.dat": GOOD_GAME() } });
      },
    },
    {
      name: "an asset is a fat library, deep in a folder",
      refusal: NativeRefusal.ExtraMachO,
      async make(base) {
        return outWith(base, { assets: { "a/b/c/plugin.bin": fat([dylib("@rpath/x.dylib")]) } });
      },
    },
    {
      name: "the run is embedded",
      refusal: NativeRefusal.Unsupported,
      mode: NativeRunMode.Embedded,
      async make(base) {
        return outWith(base);
      },
    },
  ];
  for (const row of rows) {
    it(`refuses ${row.refusal} when ${row.name}, and writes nothing`, async () => {
      const { base, runs } = await workspace("admit-");
      const out = await row.make(base);
      const before = await tree(base);
      const admission = await admitMacBundle(out, { mode: row.mode ?? NativeRunMode.Headless });
      assert.equal(admission.ok, false);
      assert.equal(admission.ok ? null : admission.refusal, row.refusal, admission.ok ? "" : admission.detail);
      assert.deepEqual(await tree(base), before);
      assert.equal(existsSync(runs), false, "no run dir");
    });
  }

  it("admits each mode's executable with its image and the staged assets", async () => {
    const { base } = await workspace("admit-ok-");
    const out = await outWith(base, {
      game: GOOD_GAME(),
      headless: machO({
        commands: [...gameCommands(), { cmd: LoadCommand.LoadDylib, value: "/usr/lib/libz.1.dylib" }],
      }),
    });
    for (const [mode, file] of [
      [NativeRunMode.Window, "game"],
      [NativeRunMode.Headless, "game-headless"],
    ] as const) {
      const bundle = await admitted(out, mode);
      assert.equal(bundle.mode, mode);
      assert.equal(bundle.exe, path.join(out, file));
      assert.equal(bundle.assets, path.join(out, "assets"));
      assert.deepEqual(bundle.image.rpaths, [MAC_GAME_RPATH]);
      assert.equal(bundle.image.dylibs.includes("/usr/lib/libz.1.dylib"), mode === NativeRunMode.Headless);
    }
  });

  it("admits a build without assets", async () => {
    const { base } = await workspace("admit-bare-");
    const out = await outWith(base);
    await rm(path.join(out, "assets"), { recursive: true });
    assert.equal((await admitted(out)).assets, null);
  });
});

describe("checkMacAngle", { skip: POSIX }, () => {
  it("accepts the pinned libraries, and refuses a wrong digest, size, shape or an OpenGL import", async () => {
    const base = await tmpDir("angle-check-");
    const angle = await storeWith(base);
    assert.equal(await checkMacAngle(angle), null);
    assert.equal(await checkMacAngle({ ...angle, manifestSha256: "0".repeat(64) }), NativeRefusal.AngleDigest);

    const swapped = await storeWith(await tmpDir("angle-swapped-"));
    await writeFile(
      swapped.gles,
      dylib("@rpath/libGLESv2.dylib", ["/usr/lib/libSystem.B.dylib", "/usr/lib/libz.1.dylib"]),
    );
    assert.equal(await checkMacAngle(swapped), NativeRefusal.AngleDigest, "bytes the manifest does not name");

    const linked = await storeWith(await tmpDir("angle-linked-"));
    await rm(linked.egl);
    await symlink(swapped.egl, linked.egl);
    assert.equal(await checkMacAngle(linked), NativeRefusal.AngleDigest, "a link is never read through");

    const thick = await storeWith(await tmpDir("angle-fat-"), { gles: fat([dylib("@rpath/libGLESv2.dylib")]) });
    assert.equal(await checkMacAngle(thick), NativeRefusal.AngleDigest, "a fat library is not the pinned build");

    const withGl = await storeWith(await tmpDir("angle-gl-"), { gles: dylib("@rpath/libGLESv2.dylib", [OPENGL]) });
    assert.equal(await checkMacAngle(withGl), NativeRefusal.LinksOpenGl);
  });
});

describe("assembleRunDir", { skip: POSIX }, () => {
  async function ready(prefix: string, mode: NativeRunMode = NativeRunMode.Headless) {
    const { base, runs } = await workspace(prefix);
    const out = await outWith(base, {
      assets: { "sprites/ship.png": "ship", "levels/one.json": '{"level":1}', "readme.txt": "hi" },
    });
    // A build-supplied ANGLE beside the executables is never what the bundle gets.
    await writeFile(path.join(out, "libGLESv2.dylib"), dylib("@rpath/libGLESv2.dylib", [OPENGL]));
    const angle = await storeWith(base);
    return { base, runs, out, angle, bundle: await admitted(out, mode) };
  }

  /** What a window run declares (lane FR): a game, so macOS Game Mode may engage in fullscreen. */
  const GAME_ENTRIES = [
    "\t<key>LSApplicationCategoryType</key>",
    "\t<string>public.app-category.games</string>",
    "\t<key>LSSupportsGameMode</key>",
    "\t<true/>",
    "\t<key>GCSupportsGameMode</key>",
    "\t<true/>",
  ];

  const PLIST = (uiElement: boolean) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "\t<key>CFBundleExecutable</key>",
      "\t<string>game</string>",
      "\t<key>CFBundleIdentifier</key>",
      `\t<string>${BUNDLE_ID}</string>`,
      "\t<key>CFBundleInfoDictionaryVersion</key>",
      "\t<string>6.0</string>",
      "\t<key>CFBundleName</key>",
      "\t<string>Pong &amp; &lt;Co&gt;</string>",
      "\t<key>CFBundlePackageType</key>",
      "\t<string>APPL</string>",
      "\t<key>LSMinimumSystemVersion</key>",
      "\t<string>13.0</string>",
      "\t<key>NSHighResolutionCapable</key>",
      "\t<true/>",
      ...(uiElement ? ["\t<key>LSUIElement</key>", "\t<true/>"] : GAME_ENTRIES),
      "</dict>",
      "</plist>",
      "",
    ].join("\n");

  it("lays out exactly bundle (r-x) and state (rwx), the store's ANGLE, the assets and a host Info.plist", async () => {
    const { runs, angle, bundle, out } = await ready("assemble-");
    const { exec, calls } = fakeExec();
    const run = await assembleRunDir({
      root: runs,
      runId: RUN_ID,
      admitted: bundle,
      angle,
      bundleId: BUNDLE_ID,
      uiElement: true,
      gameName: "Pong & <Co>",
      exec,
    });
    const runDir = path.join(await realpath(runs), RUN_ID);
    const contents = path.join(runDir, "bundle", NATIVE_BUNDLE_APP, "Contents");
    assert.deepEqual(run, {
      runDir,
      exe: path.join(contents, "MacOS", "game"),
      bundle: path.join(runDir, "bundle"),
      state: path.join(runDir, "state"),
    });
    assert.deepEqual(await readdir(runDir), ["bundle", "state"]);
    assert.equal((await stat(path.join(runDir, "bundle"))).mode & 0o777, 0o555);
    assert.equal((await stat(path.join(runDir, "state"))).mode & 0o777, 0o700);
    assert.equal((await stat(runDir)).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(path.join(runDir, "state"))).sort(), ["captures", "home"]);
    const files = (await tree(path.join(runDir, "bundle"))).filter((line) => !line.includes("/ "));
    assert.deepEqual(
      files.map((line) => line.split(" ")[0]),
      [
        `${NATIVE_BUNDLE_APP}/Contents/Frameworks/libEGL.dylib`,
        `${NATIVE_BUNDLE_APP}/Contents/Frameworks/libGLESv2.dylib`,
        `${NATIVE_BUNDLE_APP}/Contents/Info.plist`,
        `${NATIVE_BUNDLE_APP}/Contents/MacOS/game`,
        `${NATIVE_BUNDLE_APP}/Contents/Resources/assets/levels/one.json`,
        `${NATIVE_BUNDLE_APP}/Contents/Resources/assets/readme.txt`,
        `${NATIVE_BUNDLE_APP}/Contents/Resources/assets/sprites/ship.png`,
      ],
    );
    for (const line of await tree(path.join(runDir, "bundle"))) {
      const mode = line.split(" ").at(-1);
      assert.ok(mode === "555" || mode === "444", `read-only: ${line}`);
    }
    assert.equal((await stat(run.exe)).mode & 0o777, 0o555);
    assert.deepEqual(await readFile(run.exe), await readFile(path.join(out, "game-headless")));
    assert.deepEqual(await readFile(path.join(contents, "Frameworks", "libGLESv2.dylib")), await readFile(angle.gles));
    assert.deepEqual(await readFile(path.join(contents, "Frameworks", "libEGL.dylib")), await readFile(angle.egl));
    assert.equal(await readFile(path.join(contents, "Info.plist"), "utf8"), PLIST(true));
    assert.equal(
      await readFile(path.join(contents, "Resources", "assets", "levels", "one.json"), "utf8"),
      '{"level":1}',
    );
    // Inside out: each library, then the app.
    assert.deepEqual(calls, [
      [
        "/usr/bin/codesign",
        "--force",
        "-s",
        "-",
        "--timestamp=none",
        path.join(contents, "Frameworks", "libEGL.dylib"),
      ],
      [
        "/usr/bin/codesign",
        "--force",
        "-s",
        "-",
        "--timestamp=none",
        path.join(contents, "Frameworks", "libGLESv2.dylib"),
      ],
      ["/usr/bin/codesign", "--force", "-s", "-", "--timestamp=none", path.join(runDir, "bundle", NATIVE_BUNDLE_APP)],
    ]);
  });

  it("a window run without uiElement gets a Dock-capable Info.plist; a headless run never does", async () => {
    const window = await ready("assemble-window-", NativeRunMode.Window);
    const run = await assembleRunDir({
      root: window.runs,
      runId: RUN_ID,
      admitted: window.bundle,
      angle: window.angle,
      bundleId: BUNDLE_ID,
      uiElement: false,
      gameName: "Pong & <Co>",
      exec: fakeExec().exec,
    });
    assert.equal(
      await readFile(path.join(run.bundle, NATIVE_BUNDLE_APP, "Contents", "Info.plist"), "utf8"),
      PLIST(false),
    );
    const agent = await ready("assemble-agent-");
    const headless = await assembleRunDir({
      root: agent.runs,
      runId: RUN_ID,
      admitted: agent.bundle,
      angle: agent.angle,
      bundleId: BUNDLE_ID,
      uiElement: false,
      gameName: "Pong & <Co>",
      exec: fakeExec().exec,
    });
    assert.equal(
      await readFile(path.join(headless.bundle, NATIVE_BUNDLE_APP, "Contents", "Info.plist"), "utf8"),
      PLIST(true),
    );
  });

  /** Requests assembly refuses before it writes anything, each made from a good one. */
  const refused: Array<{
    name: string;
    refusal: NativeRefusal;
    patch(r: Awaited<ReturnType<typeof ready>>): Promise<Record<string, unknown>>;
  }> = [
    ...["../x", "a/b", "", "f".repeat(200), "0123456789ABCDEF", "0123456789a", "0123456789abcdef\n"].map((runId) => ({
      name: `the run id ${JSON.stringify(runId.length > 40 ? `${runId.slice(0, 8)}…(${runId.length})` : runId)}`,
      refusal: NativeRefusal.Unsupported,
      patch: async () => ({ runId }),
    })),
    ...["games.genex.desktop", "games.genex.game.0123456789ab<", "games.genex.game.0123456789", ""].map((bundleId) => ({
      name: `the bundle id ${JSON.stringify(bundleId)}`,
      refusal: NativeRefusal.Unsupported,
      patch: async () => ({ bundleId }),
    })),
    {
      name: "a store ANGLE whose manifest is not the pin",
      refusal: NativeRefusal.AngleDigest,
      patch: async (r) => ({ angle: { ...r.angle, manifestSha256: "f".repeat(64) } }),
    },
    {
      name: "a store libGLESv2 that links OpenGL",
      refusal: NativeRefusal.LinksOpenGl,
      patch: async (r) => ({
        angle: await storeWith(path.join(r.base, "gl-store"), { gles: dylib("@rpath/libGLESv2.dylib", [OPENGL]) }),
      }),
    },
    {
      name: "an executable swapped for one linking OpenGL after admission",
      refusal: NativeRefusal.LinksOpenGl,
      patch: async (r) => {
        await writeFile(r.bundle.exe, machO({ commands: gameCommands({ dylibs: [...MAC_ANGLE_IMPORTS, OPENGL] }) }));
        return {};
      },
    },
    {
      name: "an executable swapped for a link after admission",
      refusal: NativeRefusal.Symlink,
      patch: async (r) => {
        await rm(r.bundle.exe);
        await symlink(path.join(r.out, "game"), r.bundle.exe);
        return {};
      },
    },
    {
      name: "an asset swapped for a link after admission",
      refusal: NativeRefusal.Symlink,
      patch: async (r) => {
        await rm(path.join(r.out, "assets", "readme.txt"));
        await symlink("/etc/hosts", path.join(r.out, "assets", "readme.txt"));
        return {};
      },
    },
    {
      name: "an asset given a second hard link after admission",
      refusal: NativeRefusal.HardLink,
      patch: async (r) => {
        await link(path.join(r.out, "assets", "readme.txt"), path.join(r.base, "kept-asset-link"));
        return {};
      },
    },
    {
      name: "an asset swapped for a Mach-O after admission",
      refusal: NativeRefusal.ExtraMachO,
      patch: async (r) => {
        await writeFile(path.join(r.out, "assets", "readme.txt"), GOOD_GAME());
        return {};
      },
    },
  ];
  for (const row of refused) {
    it(`refuses ${row.name} (${row.refusal}) and writes nothing`, async () => {
      const r = await ready("assemble-refused-");
      const { exec, calls } = fakeExec();
      const patch = await row.patch(r);
      const before = await tree(r.runs);
      const request = {
        root: r.runs,
        runId: RUN_ID,
        admitted: r.bundle,
        angle: r.angle,
        bundleId: BUNDLE_ID,
        uiElement: true,
        exec,
        ...patch,
      };
      await assert.rejects(assembleRunDir(request as never), (error: unknown) => refusal(error) === row.refusal);
      assert.deepEqual(await tree(r.runs), before, "no run dir");
      assert.deepEqual(calls, [], "nothing signed");
    });
  }

  /**
   * A process the build left running can still write `out/` while the host assembles: between the
   * asset listing and the copies it swaps a folder of `out/assets` for a link to a folder outside
   * the game. The unsandboxed host must copy nothing from there into the bundle.
   */
  const swaps: Array<{ name: string; swap: (assets: string, outside: string) => Promise<void> }> = [
    {
      name: "an asset folder swapped for a link to an outside folder",
      swap: async (assets, outside) => {
        await rename(path.join(assets, "sprites"), path.join(assets, "sprites-was"));
        await symlink(outside, path.join(assets, "sprites"));
      },
    },
    {
      name: "the assets folder itself swapped for a link to an outside folder",
      swap: async (assets, outside) => {
        // Every listed name is there, so only the swap itself can stop the copy.
        for (const folder of ["sprites", "levels"]) await mkdir(path.join(outside, folder), { recursive: true });
        await rename(path.join(outside, "ship.png"), path.join(outside, "sprites", "ship.png"));
        await writeFile(path.join(outside, "levels", "one.json"), "{}");
        await writeFile(path.join(outside, "readme.txt"), "outside");
        await rename(assets, `${assets}-was`);
        await symlink(outside, assets);
      },
    },
    {
      name: "an asset file replaced by another file between the listing and the copy",
      swap: async (assets, outside) => {
        await rm(path.join(assets, "sprites", "ship.png"));
        await rename(path.join(outside, "ship.png"), path.join(assets, "sprites", "ship.png"));
      },
    },
  ];
  for (const row of swaps) {
    it(`refuses ${row.name} between listing and copy, copies no outside bytes and leaves no run dir`, async () => {
      const r = await ready("assemble-swap-");
      const outside = path.join(r.base, "outside");
      await mkdir(outside);
      const secret = "-----BEGIN OPENSSH PRIVATE KEY----- not the game's";
      await writeFile(path.join(outside, "ship.png"), secret);
      const { exec, calls } = fakeExec();
      await assert.rejects(
        assembleRunDir({
          root: r.runs,
          runId: RUN_ID,
          admitted: r.bundle,
          angle: r.angle,
          bundleId: BUNDLE_ID,
          uiElement: true,
          exec,
          afterListing: () => row.swap(path.join(r.out, "assets"), outside),
        }),
        (error: unknown) => error instanceof NativeError,
      );
      assert.deepEqual(await readdir(r.runs), [], "no run dir");
      assert.deepEqual(calls, [], "nothing signed");
    });
  }

  it("leaves no run dir when signing fails", async () => {
    const r = await ready("assemble-unsigned-");
    await assert.rejects(
      assembleRunDir({
        root: r.runs,
        runId: RUN_ID,
        admitted: r.bundle,
        angle: r.angle,
        bundleId: BUNDLE_ID,
        uiElement: true,
        exec: fakeExec(1).exec,
      }),
      (error: unknown) => error instanceof NativeError,
    );
    assert.deepEqual(await readdir(r.runs), []);
  });

  it("never reuses a run dir that is already there", async () => {
    const r = await ready("assemble-twice-");
    await mkdir(path.join(r.runs, RUN_ID), { recursive: true });
    await writeFile(path.join(r.runs, RUN_ID, "kept"), "kept");
    const before = await tree(r.runs);
    await assert.rejects(
      assembleRunDir({
        root: r.runs,
        runId: RUN_ID,
        admitted: r.bundle,
        angle: r.angle,
        bundleId: BUNDLE_ID,
        uiElement: true,
        exec: fakeExec().exec,
      }),
      (error: unknown) => refusal(error) === NativeRefusal.Unsupported,
    );
    assert.deepEqual(await tree(r.runs), before);
  });

  it("copies regular assets only: a FIFO is skipped without blocking", async () => {
    const r = await ready("assemble-fifo-");
    await execFileAsync("mkfifo", [path.join(r.out, "assets", "pipe.dat")]);
    const run = await assembleRunDir({
      root: r.runs,
      runId: RUN_ID,
      admitted: r.bundle,
      angle: r.angle,
      bundleId: BUNDLE_ID,
      uiElement: true,
      exec: fakeExec().exec,
    });
    const assets = path.join(run.bundle, NATIVE_BUNDLE_APP, "Contents", "Resources", "assets");
    assert.deepEqual((await readdir(assets)).sort(), ["levels", "readme.txt", "sprites"]);
  });

  it("removeRunDir removes a read-only run dir whole", async () => {
    const r = await ready("assemble-remove-");
    const run = await assembleRunDir({
      root: r.runs,
      runId: RUN_ID,
      admitted: r.bundle,
      angle: r.angle,
      bundleId: BUNDLE_ID,
      uiElement: true,
      exec: fakeExec().exec,
    });
    await removeRunDir(run.runDir);
    assert.deepEqual(await readdir(r.runs), []);
  });
});

/** codesign and otool, without a shell: what the host's `exec` is in production. */
const hostExec: BundleExec = async (file, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
};

const FIXTURES = path.resolve(import.meta.dirname, "..", "cpp", "bundle_fixtures");

/** The stub ANGLE pair and an executable linked against it, built by clang. */
async function clangBuilt(base: string) {
  const bin = path.join(base, "clang-out");
  await mkdir(bin, { recursive: true });
  const egl = path.join(bin, "libEGL.dylib");
  const gles = path.join(bin, "libGLESv2.dylib");
  const version = "-mmacosx-version-min=13.0";
  await macClang([
    version,
    "-dynamiclib",
    "-install_name",
    "@rpath/libEGL.dylib",
    path.join(FIXTURES, "stub_egl.c"),
    "-o",
    egl,
  ]);
  await macClang([
    version,
    "-dynamiclib",
    "-install_name",
    "@rpath/libGLESv2.dylib",
    path.join(FIXTURES, "stub_gles.c"),
    "-o",
    gles,
  ]);
  const exe = path.join(bin, "game");
  await macClang([
    version,
    path.join(FIXTURES, "exe.c"),
    "-o",
    exe,
    `-L${bin}`,
    "-lEGL",
    "-lGLESv2",
    `-Wl,-rpath,${MAC_GAME_RPATH}`,
  ]);
  return { egl, gles, exe };
}

describe("a clang-built game, assembled and signed (darwin)", { skip: macClangSkip() }, () => {
  async function assembled(
    prefix: string,
    angleFor?: (built: Awaited<ReturnType<typeof clangBuilt>>, base: string) => Promise<MacAngle>,
  ) {
    const { base, runs } = await workspace(prefix);
    const built = await clangBuilt(base);
    const out = await outWith(base, { game: await readFile(built.exe) });
    await copyFile(built.gles, path.join(out, "libGLESv2.dylib"));
    const angle = angleFor
      ? await angleFor(built, base)
      : await storeWith(base, { egl: await readFile(built.egl), gles: await readFile(built.gles) });
    const run = await assembleRunDir({
      root: runs,
      runId: RUN_ID,
      admitted: await admitted(out),
      angle,
      bundleId: BUNDLE_ID,
      uiElement: true,
      gameName: "Pong",
      exec: hostExec,
    });
    return { run, runs, angle };
  }

  it("otool shows the ANGLE imports and no OpenGL, and codesign --verify --strict passes", {
    timeout: 120_000,
  }, async () => {
    const { run } = await assembled("bundle-real-");
    const { stdout } = await execFileAsync("/usr/bin/otool", ["-L", run.exe]);
    for (const name of MAC_ANGLE_IMPORTS) assert.match(stdout, new RegExp(name.replace(/[.$]/g, "\\$&")));
    assert.doesNotMatch(stdout, /OpenGL/i);
    const app = path.join(run.bundle, NATIVE_BUNDLE_APP);
    const verified = await hostExec("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", app]);
    assert.equal(verified.code, 0, verified.stderr);
    assert.deepEqual(parseMachO(await readFile(run.exe)).rpaths, [MAC_GAME_RPATH]);
  });

  const owned = devTool("angleMac");
  const ownedSkip = "skip" in owned ? owned.skip : false;

  it("the owned Metal-only ANGLE passes the store check with its pin", {
    skip: ownedSkip,
    timeout: 60_000,
  }, async () => {
    if ("skip" in owned) return;
    const pinned = manifestEntry(ToolchainId.AngleMac, ToolchainHost.MacArm64);
    assert.ok(pinned);
    const angle = {
      dir: owned.path,
      egl: path.join(owned.path, "libEGL.dylib"),
      gles: path.join(owned.path, "libGLESv2.dylib"),
      manifestSha256: entryDigest(pinned),
    };
    assert.equal(await checkMacAngle(angle), null);
  });

  const electron = path.resolve(
    import.meta.dirname,
    "../../node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Libraries",
  );
  it("Electron's own ANGLE is refused: its libGLESv2 links OpenGL", {
    skip: !existsSync(path.join(electron, "libGLESv2.dylib")) && "not run: Electron's ANGLE absent",
  }, async () => {
    const base = await tmpDir("angle-electron-");
    const angle = await storeWith(base, {
      egl: await readFile(path.join(electron, "libEGL.dylib")),
      gles: await readFile(path.join(electron, "libGLESv2.dylib")),
    });
    assert.equal(await checkMacAngle(angle), NativeRefusal.LinksOpenGl);
  });

  it("an assembled game binds the owned ANGLE from its bundle and initializes EGL on Metal under the headless profile", {
    skip: ownedSkip,
    timeout: 120_000,
  }, async (t) => {
    if ("skip" in owned) return;
    const pinned = manifestEntry(ToolchainId.AngleMac, ToolchainHost.MacArm64);
    assert.ok(pinned);
    const { run, runs } = await assembled("bundle-owned-", async () => ({
      dir: owned.path,
      egl: path.join(owned.path, "libEGL.dylib"),
      gles: path.join(owned.path, "libGLESv2.dylib"),
      manifestSha256: entryDigest(pinned),
    }));
    const sandbox = await ProcessSandbox.create({
      writableRoots: [],
      scratchDir: path.join(path.dirname(runs), "agent-scratch"),
      secretPaths: [],
      enabled: false,
      nativeRunsRoot: runs,
    });
    try {
      const child = await sandbox.spawnGame({ ...run, runId: RUN_ID, mode: NativeRunMode.Headless, nonce: "a1b2c3d4" });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const line = await new Promise<string>((resolve) => {
        let held = "";
        child.fd3.on("data", (chunk: Buffer) => {
          held += chunk.toString("utf8");
          if (held.includes("\n")) resolve(held.split("\n")[0] ?? "");
        });
        child.fd3.on("end", () => resolve(held));
      });
      const exited = await child.exited;
      t.diagnostic(`fd3: ${line}; exit ${JSON.stringify(exited)}; stderr: ${stderr.slice(0, 400)}`);
      assert.deepEqual(exited, { code: 0, signal: null }, stderr);
      const report = JSON.parse(line) as { egl: number; vendor: string };
      assert.equal(report.egl, 1, line);
      assert.match(report.vendor, /Google/, "ANGLE, not the stub");
    } finally {
      await sandbox.dispose();
    }
  });
});

describe("Rust · wgpu Mach-O admission for the Mac and iOS (M3.5)", () => {
  const OPENGL_ES = "/System/Library/Frameworks/OpenGLES.framework/OpenGLES";
  const NETWORK = "/System/Library/Frameworks/Network.framework/Versions/A/Network";
  const refusedAs = (bytes: Buffer, target: typeof BuildTarget.Mac | typeof BuildTarget.Ios) => {
    const admission = admitRustMachO(bytes, target);
    return admission.ok ? "admitted" : `${admission.refusal}/${admission.problem}`;
  };

  it("admits the Mac, iOS device and iOS Simulator builds M2 linked, imports as they were", () => {
    assert.equal(refusedAs(macBinary(), BuildTarget.Mac), "admitted");
    assert.equal(refusedAs(iosBinary(), BuildTarget.Ios), "admitted");
    assert.equal(refusedAs(iosSimulatorBinary(), BuildTarget.Ios), "admitted");
    const admission = admitRustMachO(iosBinary(), BuildTarget.Ios);
    assert.ok(admission.ok);
    assert.deepEqual(admission.version, { platform: ApplePlatform.Ios, minos: "16.0" });
    assert.deepEqual(admission.image.dylibs, M2["ios-device"].dylibs);
  });

  const hostile: Array<[string, Buffer, typeof BuildTarget.Mac | typeof BuildTarget.Ios, string]> = [
    [
      "an extra dylib beside the game (@rpath)",
      macBinary({ dylibs: [...M2.mac.dylibs, "@rpath/libextra.dylib"] }),
      BuildTarget.Mac,
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "an iOS dylib of its own (no dylibs on iOS)",
      iosBinary({ dylibs: [...M2["ios-device"].dylibs, "@executable_path/Frameworks/libgame.dylib"] }),
      BuildTarget.Ios,
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "a system library outside the allow-list (/usr/local/lib)",
      macBinary({ dylibs: [...M2.mac.dylibs, "/usr/local/lib/libcurl.4.dylib"] }),
      BuildTarget.Mac,
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "a framework outside the allow-list (Network)",
      macBinary({ dylibs: [...M2.mac.dylibs, NETWORK] }),
      BuildTarget.Mac,
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "an allowed framework reached through a dot-dot path",
      macBinary({ dylibs: ["/System/Library/Frameworks/../Frameworks/Metal.framework/Metal"] }),
      BuildTarget.Mac,
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    ],
    [
      "an OpenGL import",
      macBinary({ dylibs: [...M2.mac.dylibs, OPENGL] }),
      BuildTarget.Mac,
      `${NativeRefusal.LinksOpenGl}/${RustAdmissionProblem.OpenGl}`,
    ],
    [
      "an OpenGL ES import on iOS",
      iosBinary({ dylibs: [...M2["ios-device"].dylibs, OPENGL_ES] }),
      BuildTarget.Ios,
      `${NativeRefusal.LinksOpenGl}/${RustAdmissionProblem.OpenGl}`,
    ],
    [
      "LC_DYLD_ENVIRONMENT",
      macBinary({ environment: ["DYLD_INSERT_LIBRARIES=/tmp/x.dylib"] }),
      BuildTarget.Mac,
      `${NativeRefusal.ForeignRpath}/${RustAdmissionProblem.DyldEnvironment}`,
    ],
    [
      "LC_DYLD_ENVIRONMENT on iOS",
      iosBinary({ environment: ["DYLD_LIBRARY_PATH=/tmp"] }),
      BuildTarget.Ios,
      `${NativeRefusal.ForeignRpath}/${RustAdmissionProblem.DyldEnvironment}`,
    ],
    [
      "an rpath",
      macBinary({ rpaths: ["@executable_path/../Frameworks"] }),
      BuildTarget.Mac,
      `${NativeRefusal.ForeignRpath}/${RustAdmissionProblem.SearchPath}`,
    ],
    [
      "minos 10.0 (rustc's default) on iOS",
      iosBinary({ minos: "10.0" }),
      BuildTarget.Ios,
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.MinosMismatch}`,
    ],
    [
      "minos 17.0 on iOS (MinimumOSVersion is 16)",
      iosSimulatorBinary({ minos: "17.0" }),
      BuildTarget.Ios,
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.MinosMismatch}`,
    ],
    [
      "a Mac build offered as iOS",
      macBinary(),
      BuildTarget.Ios,
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.WrongPlatform}`,
    ],
    [
      "an iOS build offered as the Mac",
      iosBinary(),
      BuildTarget.Mac,
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.WrongPlatform}`,
    ],
    [
      "an iOS build with no LC_BUILD_VERSION",
      iosBinary({ platform: null }),
      BuildTarget.Ios,
      `${NativeRefusal.WrongMachine}/${RustAdmissionProblem.WrongPlatform}`,
    ],
    [
      "a library, not an executable",
      macBinary({ fileType: MachOFile.Dylib }),
      BuildTarget.Mac,
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.NotAnExecutable}`,
    ],
    [
      "an x86-64 image",
      Buffer.from(machO({ cpuType: CPU_X86_64 })),
      BuildTarget.Mac,
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.Unreadable}`,
    ],
    [
      "a universal (fat) file",
      fat([macBinary(), macBinary()]),
      BuildTarget.Ios,
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.Unreadable}`,
    ],
  ];
  for (const [label, bytes, target, expected] of hostile) {
    it(`refuses ${label} for ${target}, typed`, () => {
      assert.equal(refusedAs(bytes, target), expected);
    });
  }

  it("a wgpu window run's bundle declares a game for Game Mode, still signed ad hoc; a headless run's does not", async () => {
    const { base, runs } = await workspace("wgpu-game-mode-");
    const plistOf = async (mode: NativeRunMode, runId: string) => {
      const out = await outWith(path.join(base, runId), { game: macBinary(), headless: macBinary() });
      const admission = await admitWgpuBundle(out, { mode });
      assert.ok(admission.ok, admission.ok ? "" : `${admission.refusal}: ${admission.detail}`);
      const { exec, calls } = fakeExec();
      const admittedFiles = (await admittedReport(out)).receipt?.outputs ?? [];
      const run = await assembleWgpuRunDir({
        root: runs,
        runId,
        admitted: admission.bundle,
        bundleId: BUNDLE_ID,
        uiElement: false,
        gameName: "Horde",
        exec,
        admittedFiles,
      });
      const app = path.join(run.bundle, NATIVE_BUNDLE_APP);
      assert.deepEqual(
        calls,
        [["/usr/bin/codesign", "--force", "-s", "-", "--timestamp=none", app]],
        "the app alone, ad hoc",
      );
      return readFile(path.join(app, "Contents", "Info.plist"), "utf8");
    };
    const window = await plistOf(NativeRunMode.Window, RUN_ID);
    const value = (plist: string, key: string) => new RegExp(`<key>${key}</key>\\n\\t([^\\n]*)`).exec(plist)?.[1];
    assert.equal(value(window, "LSApplicationCategoryType"), "<string>public.app-category.games</string>");
    assert.equal(value(window, "LSSupportsGameMode"), "<true/>");
    assert.equal(value(window, "GCSupportsGameMode"), "<true/>");
    assert.equal(value(window, "LSUIElement"), undefined);
    const headless = await plistOf(NativeRunMode.Headless, "fedcba9876543210");
    assert.equal(value(headless, "LSUIElement"), "<true/>");
    for (const key of ["LSApplicationCategoryType", "LSSupportsGameMode", "GCSupportsGameMode"]) {
      assert.equal(value(headless, key), undefined, `a background run claims no ${key}`);
    }
  });

  it("holds the Mac run's admission to the same allow-list: a framework outside it is refused", async () => {
    const base = await tmpDir("wgpu-allow-");
    try {
      const out = await outWith(base, { game: macBinary({ dylibs: [...M2.mac.dylibs, NETWORK] }) });
      const refused = await admitWgpuBundle(out, { mode: NativeRunMode.Headless });
      assert.equal(refused.ok, false);
      assert.equal(!refused.ok && refused.refusal, NativeRefusal.ForeignImport);
      const fine = await outWith(path.join(base, "fine"), { game: macBinary() });
      assert.equal((await admitWgpuBundle(fine, { mode: NativeRunMode.Window })).ok, true);
      const iosOut = await outWith(path.join(base, "ios"), { game: iosBinary() });
      const ios = await admitWgpuBundle(iosOut, { mode: NativeRunMode.Window });
      assert.equal(!ios.ok && ios.refusal, NativeRefusal.WrongMachine, "a run starts Mac builds only");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
