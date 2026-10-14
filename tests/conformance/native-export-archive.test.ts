/**
 * The Windows zip and Linux tar.gz export archives (`src/substrate/native-export-archive.ts`,
 * plan §7.7 / M4b): the layouts, read back by the system's `unzip` and `tar` and by the store's own
 * pure-TS reader; byte-identical output for the same input; names Windows refuses, escaping paths,
 * links and held secrets refused before anything lands; the notices and README each destination
 * carries.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { ArchiveFormat } from "../../src/shared/toolchain.ts";
import {
  ARCHIVE_EPOCH_SECONDS,
  ArchiveRefusal,
  type AssetFile,
  checkArchivePath,
  composeNotices,
  writeLinuxTarGz,
  writeWindowsZip,
  type LinuxArchiveInput,
  LinuxRuntimeFile,
  linuxArchiveItems,
  linuxArchiveName,
  linuxExportName,
  NativeArchiveError,
  NOTICES_FILE,
  NoticeComponent,
  type NoticeText,
  pinnedFile,
  README_FILE,
  readAssetTree,
  SUMS_FILE,
  type WindowsArchiveInput,
  WindowsRuntimeFile,
  windowsArchiveItems,
  windowsArchiveName,
  windowsExportName,
} from "../../src/substrate/native-export-archive.ts";
import { ArchiveEntryType, extractArchive, listArchive } from "../../src/substrate/toolchain-store/archive.ts";
import { windowsNameProblem } from "../../src/substrate/windows-names.ts";
import { tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);

function hasTool(name: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const POSIX = process.platform !== "win32";
const UNZIP = POSIX && hasTool("unzip");
const TAR = POSIX && hasTool("tar");

/** Deterministic bytes that do not compress (so the zip stores them) of `size`. */
function noise(seed: string, size: number): Buffer {
  const out: Buffer[] = [];
  let block = createHash("sha256").update(seed).digest();
  for (let total = 0; total < size; total += block.length) {
    out.push(block);
    block = createHash("sha256").update(block).digest();
  }
  return Buffer.concat(out).subarray(0, size);
}

const bytes = (text: string) => ({ bytes: Buffer.from(text) });

type DesktopTarget = typeof BuildTarget.Windows | typeof BuildTarget.Linux;

function notices(target: DesktopTarget): NoticeText[] {
  const all: NoticeText[] = [
    { component: NoticeComponent.Angle, source: "licenses/angle.txt", text: "ANGLE licence text" },
    { component: NoticeComponent.Raylib, source: "raylib/LICENSE", text: "raylib zlib licence" },
    { component: NoticeComponent.Glfw, source: "raylib/src/external/glfw/LICENSE.md", text: "GLFW zlib licence" },
    { component: NoticeComponent.Miniaudio, source: "raylib/src/external/miniaudio.h", text: "MIT No Attribution" },
    { component: NoticeComponent.LlvmRuntime, source: "zig/lib/libcxx/LICENSE.TXT", text: "Apache-2.0 WITH LLVM" },
    { component: NoticeComponent.ZigRuntime, source: "zig/LICENSE", text: "Zig MIT licence" },
    { component: NoticeComponent.GameThirdParty, source: "third_party/stb/LICENSE", text: "stb public domain" },
    { component: NoticeComponent.GameThirdParty, source: "third_party/enet/LICENSE", text: "enet MIT" },
  ];
  const own: NoticeText[] =
    target === BuildTarget.Windows
      ? [{ component: NoticeComponent.MingwRuntime, source: "zig/lib/libc/mingw/COPYING", text: "mingw-w64 runtime" }]
      : [
          { component: NoticeComponent.SwiftShader, source: "licenses/SwiftShader.txt", text: "SwiftShader Apache" },
          {
            component: NoticeComponent.WaylandProtocols,
            source: "linux-sysroot/glfw-wayland/xdg-shell-client-protocol-code.h",
            text: "Copyright Kristian Hogsberg, MIT",
          },
        ];
  return [...all, ...own];
}

const without = (target: DesktopTarget, component: NoticeComponent) =>
  notices(target).filter((notice) => notice.component !== component);

const ASSETS: AssetFile[] = [
  { path: "sprites/hero.png", content: { bytes: noise("hero", 3000) } },
  { path: "levels/one.json", content: bytes('{"tiles":[0,0,0,0]}\n'.repeat(200)) },
  { path: "music.ogg", content: { bytes: noise("music", 777) } },
];

function windowsInput(overrides: Partial<WindowsArchiveInput> = {}): WindowsArchiveInput {
  return {
    name: "Space Rocks",
    executable: { bytes: noise("exe", 4096) },
    runtime: {
      [WindowsRuntimeFile.Egl]: bytes("egl dll"),
      [WindowsRuntimeFile.Gles]: bytes("gles dll"),
      [WindowsRuntimeFile.D3dCompiler]: bytes("d3dcompiler dll"),
    },
    assets: ASSETS,
    notices: notices(BuildTarget.Windows),
    builtOn: StudioPlatform.Mac,
    ranOnTarget: false,
    ...overrides,
  };
}

function linuxInput(overrides: Partial<LinuxArchiveInput> = {}): LinuxArchiveInput {
  return {
    name: "space-rocks",
    executable: { bytes: noise("elf", 4096) },
    runtime: {
      [LinuxRuntimeFile.Egl]: bytes("egl so"),
      [LinuxRuntimeFile.Gles]: bytes("gles so"),
      [LinuxRuntimeFile.VulkanLoader]: bytes("vulkan loader so"),
      [LinuxRuntimeFile.SwiftShader]: bytes("swiftshader so"),
      [LinuxRuntimeFile.SwiftShaderIcd]: bytes('{"ICD":{"library_path":"./libvk_swiftshader.so"}}'),
    },
    assets: ASSETS,
    notices: notices(BuildTarget.Linux),
    builtOn: StudioPlatform.Mac,
    ranOnTarget: false,
    ...overrides,
  };
}

const WINDOWS_LAYOUT = [
  "Space Rocks/",
  `Space Rocks/${README_FILE}`,
  "Space Rocks/Space Rocks.exe",
  `Space Rocks/${NOTICES_FILE}`,
  "Space Rocks/assets/",
  "Space Rocks/assets/levels/",
  "Space Rocks/assets/levels/one.json",
  "Space Rocks/assets/music.ogg",
  "Space Rocks/assets/sprites/",
  "Space Rocks/assets/sprites/hero.png",
  "Space Rocks/d3dcompiler_47.dll",
  "Space Rocks/libEGL.dll",
  "Space Rocks/libGLESv2.dll",
  `Space Rocks/${SUMS_FILE}`,
];

const LINUX_LAYOUT = [
  "space-rocks/",
  `space-rocks/${README_FILE}`,
  `space-rocks/${NOTICES_FILE}`,
  "space-rocks/assets/",
  "space-rocks/assets/levels/",
  "space-rocks/assets/levels/one.json",
  "space-rocks/assets/music.ogg",
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

async function sha256File(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** Asserts `write` is refused with `code`. */
async function refused(write: () => Promise<unknown>, code: ArchiveRefusal, label?: string): Promise<void> {
  await assert.rejects(
    write,
    (error: unknown) => {
      assert.ok(error instanceof NativeArchiveError, label);
      assert.equal(error.code, code, label);
      return true;
    },
    label,
  );
}

describe("the Windows zip", () => {
  it("holds <Game>/<Game>.exe, the three DLLs, assets, notices and README, in sorted order", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, windowsArchiveName("Space Rocks"));
    const summary = await writeWindowsZip(file, windowsInput());
    assert.equal(path.basename(file), "Space Rocks-windows-x64.zip");
    assert.deepEqual(summary.entries, WINDOWS_LAYOUT);
    assert.equal(summary.sha256, await sha256File(file));
    assert.equal(summary.bytes, (await stat(file)).size);
    const listed = await listArchive(file, ArchiveFormat.Zip);
    assert.deepEqual(
      listed.map((entry) => entry.name),
      WINDOWS_LAYOUT,
    );
    const linked = listed.filter((e) => e.type === ArchiveEntryType.Symlink || e.type === ArchiveEntryType.Other);
    assert.deepEqual(linked, []);
  });

  it("is read back by unzip with every byte intact and the 1980 timestamp", { skip: !UNZIP }, async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "game.zip");
    await writeWindowsZip(file, windowsInput());
    const { stdout } = await run("unzip", ["-Z1", file]);
    assert.deepEqual(stdout.trim().split("\n"), WINDOWS_LAYOUT);
    await run("unzip", ["-tq", file]);
    const out = path.join(dir, "out");
    await run("unzip", ["-q", file, "-d", out]);
    const game = path.join(out, "Space Rocks");
    assert.deepEqual(await readFile(path.join(game, "Space Rocks.exe")), noise("exe", 4096));
    assert.deepEqual(await readFile(path.join(game, "assets/sprites/hero.png")), noise("hero", 3000));
    assert.equal(
      await readFile(path.join(game, "assets/levels/one.json"), "utf8"),
      '{"tiles":[0,0,0,0]}\n'.repeat(200),
    );
    assert.equal(await readFile(path.join(game, "libGLESv2.dll"), "utf8"), "gles dll");
    assert.equal((await stat(path.join(game, "libEGL.dll"))).mtime.getFullYear(), 1980);
  });

  it("carries SHA256SUMS last, listing every file beside it with a digest that verifies", {
    skip: !UNZIP,
  }, async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "game.zip");
    await writeWindowsZip(file, windowsInput());
    const out = path.join(dir, "out");
    await run("unzip", ["-q", file, "-d", out]);
    const game = path.join(out, "Space Rocks");
    const sums = (await readFile(path.join(game, SUMS_FILE), "utf8")).trim().split("\n");
    const listed = sums.map((line) => line.split("  ")[1]);
    const files = WINDOWS_LAYOUT.filter((name) => !name.endsWith("/") && !name.endsWith(SUMS_FILE));
    assert.deepEqual(
      listed,
      files.map((name) => name.slice("Space Rocks/".length)),
    );
    for (const line of sums) {
      const [digest, name] = line.split("  ");
      assert.equal(await sha256File(path.join(game, ...name.split("/"))), digest, name);
    }
  });

  it("is byte-identical for the same input, whatever order the assets and notices come in", async () => {
    const dir = await tmpDir();
    const one = path.join(dir, "one.zip");
    const two = path.join(dir, "two.zip");
    await writeWindowsZip(one, windowsInput());
    const reversed = { assets: [...ASSETS].reverse(), notices: notices(BuildTarget.Windows).reverse() };
    await writeWindowsZip(two, windowsInput(reversed));
    assert.equal(await sha256File(one), await sha256File(two));
  });

  it("replaces an earlier export of the same name and leaves no partial file", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "game.zip");
    await writeFile(file, "an older export");
    await writeWindowsZip(file, windowsInput());
    assert.equal((await readFile(file)).subarray(0, 2).toString("latin1"), "PK");
    assert.deepEqual(await readdir(dir), ["game.zip"]);
  });
});

describe("the Linux tar.gz", () => {
  it("holds <game>/<game>, ANGLE, SwiftShader, assets, notices, README and SHA256SUMS last", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, linuxArchiveName("space-rocks"));
    const summary = await writeLinuxTarGz(file, linuxInput());
    assert.equal(path.basename(file), "space-rocks-linux-x64.tar.gz");
    assert.deepEqual(summary.entries, LINUX_LAYOUT);
    const listed = await listArchive(file, ArchiveFormat.TarGz);
    assert.deepEqual(
      listed.map((entry) => entry.name),
      LINUX_LAYOUT,
    );
    const mode = (name: string) => (listed.find((entry) => entry.name === name)?.mode ?? 0) & 0o777;
    assert.equal(mode("space-rocks/space-rocks"), 0o755);
    assert.equal(mode("space-rocks/libGLESv2.so"), 0o644);
    assert.equal(mode("space-rocks/assets/"), 0o755);
    assert.equal(mode(`space-rocks/${README_FILE}`), 0o644);
  });

  it("is extracted by tar with the executable bit, the 1980 mtime and sums that verify", { skip: !TAR }, async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "game.tar.gz");
    await writeLinuxTarGz(file, linuxInput());
    const out = path.join(dir, "out");
    await mkdir(out);
    await run("tar", ["-xzf", file, "-C", out]);
    const game = path.join(out, "space-rocks");
    const binary = await stat(path.join(game, "space-rocks"));
    assert.equal(binary.mode & 0o777, 0o755);
    assert.equal(Math.round(binary.mtimeMs / 1000), ARCHIVE_EPOCH_SECONDS);
    const sums = (await readFile(path.join(game, SUMS_FILE), "utf8")).trim().split("\n");
    assert.equal(sums.length, 11);
    for (const line of sums) {
      const [digest, name] = line.split("  ");
      assert.equal(await sha256File(path.join(game, name)), digest, name);
    }
    assert.ok(!sums.some((line) => line.endsWith(SUMS_FILE)));
  });

  it("is byte-identical for the same input", async () => {
    const dir = await tmpDir();
    await writeLinuxTarGz(path.join(dir, "a.tar.gz"), linuxInput());
    await writeLinuxTarGz(path.join(dir, "b.tar.gz"), linuxInput({ assets: [...ASSETS].reverse() }));
    assert.equal(await sha256File(path.join(dir, "a.tar.gz")), await sha256File(path.join(dir, "b.tar.gz")));
  });

  it("names a long asset path through a pax header that tar and the store reader both follow", async () => {
    const deep = `${"deep-folder-name/".repeat(9)}${"x".repeat(60)}.bin`;
    const dir = await tmpDir();
    const file = path.join(dir, "long.tar.gz");
    await writeLinuxTarGz(file, linuxInput({ assets: [{ path: deep, content: bytes("deep") }] }));
    const listed = await listArchive(file, ArchiveFormat.TarGz);
    assert.ok(listed.some((entry) => entry.name === `space-rocks/assets/${deep}`));
    if (!TAR) return;
    const { stdout } = await run("tar", ["-tzf", file]);
    assert.ok(stdout.split("\n").includes(`space-rocks/assets/${deep}`));
  });
});

/** Names that must never reach an archive: escaping, absolute, or refused by Windows. */
const UNSAFE_ASSET_NAMES: Array<[string, string]> = [
  ["climbs out", "../escape.png"],
  ["climbs out midway", "a/../../escape.png"],
  ["absolute", "/etc/passwd"],
  ["drive letter", "C:/x.png"],
  ["backslash", "a\\b.png"],
  ["empty segment", "a//b.png"],
  ["dot segment", "./a.png"],
  ["empty", ""],
  ["reserved CON", "con.png"],
  ["reserved NUL without extension", "sub/NUL"],
  ["reserved COM1", "COM1.txt"],
  ["reserved LPT9", "lpt9.dat"],
  ["reserved COM superscript", "COM¹.txt"],
  ["reserved CONIN$", "CONIN$"],
  ["trailing dot", "sub./a.png"],
  ["trailing space", "a.png "],
  ["colon (alternate stream)", "a.png:hidden"],
  ["question mark", "what?.png"],
  ["pipe", "a|b.png"],
  ["NUL byte", "a\u0000b.png"],
  ["lone surrogate (no UTF-8 spelling of its own)", "a\uD800.png"],
  ["newline", "a\nb.png"],
  ["overlong segment", `${"a".repeat(256)}.png`],
];

describe("names refused before anything is written", () => {
  for (const [label, name] of UNSAFE_ASSET_NAMES) {
    it(`refuses an asset whose name has a ${label} in both archives and writes nothing`, async () => {
      const dir = await tmpDir();
      const assets = [{ path: name, content: bytes("x") }];
      await refused(
        () => writeWindowsZip(path.join(dir, "g.zip"), windowsInput({ assets })),
        ArchiveRefusal.UnsafeName,
      );
      await refused(() => writeLinuxTarGz(path.join(dir, "g.tgz"), linuxInput({ assets })), ArchiveRefusal.UnsafeName);
      assert.deepEqual(await readdir(dir), []);
    });
  }

  it("refuses two assets that differ only by case or Unicode form (one file on Windows and macOS)", async () => {
    const dir = await tmpDir();
    for (const pair of [
      ["Hero.png", "hero.PNG"],
      ["caf\u00e9.png", "cafe\u0301.png"],
      ["s.png", "\u017f.png"],
      ["a\u03c3.png", "a\u03c2.png"],
      ["\u00b5.png", "\u03bc.png"],
      ["\u00df.png", "ss.png"],
    ]) {
      const assets = pair.map((name) => ({ path: name, content: bytes(name) }));
      for (const write of [
        () => writeWindowsZip(path.join(dir, "g.zip"), windowsInput({ assets })),
        () => writeLinuxTarGz(path.join(dir, "g.tgz"), linuxInput({ assets })),
      ]) {
        await refused(write, ArchiveRefusal.DuplicateName, pair.join(" / "));
      }
    }
    assert.deepEqual(await readdir(dir), []);
  });

  it("refuses a Linux game name that collides with a folder the layout ships", async () => {
    const dir = await tmpDir();
    await refused(
      () => writeLinuxTarGz(path.join(dir, "g.tgz"), linuxInput({ name: "assets" })),
      ArchiveRefusal.DuplicateName,
    );
    assert.deepEqual(await readdir(dir), []);
  });

  it("refuses a Linux game name its README's shell commands would not carry as one word", async () => {
    const dir = await tmpDir();
    const rows = ["a;rm -rf ~", "a;b", "$(curl x)", "`x`", "a b", "a&b", "it's", "Space-Rocks"];
    rows.push("a--b", "libEGL.so", "SHA256SUMS", "readme.txt");
    for (const name of rows) {
      await refused(
        () => writeLinuxTarGz(path.join(dir, "g.tgz"), linuxInput({ name })),
        ArchiveRefusal.InvalidGameName,
        JSON.stringify(name),
      );
    }
    assert.deepEqual(await readdir(dir), []);
  });

  it("refuses a game name that is not one safe folder name", async () => {
    const dir = await tmpDir();
    for (const name of ["", "a/b", "..", "CON", "game.", "-rf", "x\ny", "a:b"]) {
      const label = JSON.stringify(name);
      await refused(
        () => writeWindowsZip(path.join(dir, "g.zip"), windowsInput({ name })),
        ArchiveRefusal.InvalidGameName,
        label,
      );
      await refused(
        () => writeLinuxTarGz(path.join(dir, "g.tgz"), linuxInput({ name })),
        ArchiveRefusal.InvalidGameName,
        label,
      );
    }
    assert.deepEqual(await readdir(dir), []);
  });
});

/** A game folder with `assets/sprites/hero.png` and `assets/level.json`. */
async function assetFolder(): Promise<string> {
  const root = await tmpDir();
  await mkdir(path.join(root, "assets", "sprites"), { recursive: true });
  await writeFile(path.join(root, "assets", "sprites", "hero.png"), "hero");
  await writeFile(path.join(root, "assets", "level.json"), "{}");
  return root;
}

describe("what the archive reads from disk", () => {
  it("lists regular files with /-separated paths and leaves out private names", async () => {
    const root = await assetFolder();
    await writeFile(path.join(root, "assets", ".DS_Store"), "finder");
    await writeFile(path.join(root, "assets", "deploy.pem"), "key");
    await mkdir(path.join(root, "assets", "node_modules"));
    await writeFile(path.join(root, "assets", "node_modules", "x.js"), "x");
    const files = await readAssetTree(path.join(root, "assets"));
    assert.deepEqual(
      files.map((file) => file.path),
      ["level.json", "sprites/hero.png"],
    );
  });

  it("answers no assets for a missing folder", async () => {
    const root = await tmpDir();
    assert.deepEqual(await readAssetTree(path.join(root, "assets")), []);
  });

  it("refuses a symlink inside the assets, pointing anywhere", { skip: !POSIX }, async () => {
    const root = await assetFolder();
    const outside = await tmpDir();
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "assets", "link.png"));
    await symlink(path.join(root, "assets", "level.json"), path.join(root, "assets", "inside.json"));
    await refused(() => readAssetTree(path.join(root, "assets")), ArchiveRefusal.NotARegularFile);
  });

  it("refuses an assets folder that is itself a symlink", { skip: !POSIX }, async () => {
    const root = await assetFolder();
    const elsewhere = await tmpDir();
    await symlink(path.join(root, "assets"), path.join(elsewhere, "assets"));
    await refused(() => readAssetTree(path.join(elsewhere, "assets")), ArchiveRefusal.NotARegularFile);
  });

  it("refuses a FIFO inside the assets without blocking on it", { skip: !POSIX || !hasTool("mkfifo") }, async () => {
    const root = await assetFolder();
    await run("mkfifo", [path.join(root, "assets", "pipe.png")]);
    await refused(() => readAssetTree(path.join(root, "assets")), ArchiveRefusal.NotARegularFile);
  });

  it("refuses a runtime file that is a symlink, a FIFO, a socket, missing or unreadable, and writes no archive", {
    skip: !POSIX,
  }, async () => {
    const dir = await tmpDir();
    const out = path.join(dir, "out");
    await mkdir(out);
    await writeFile(path.join(dir, "real.dll"), "dll");
    await symlink(path.join(dir, "real.dll"), path.join(dir, "link.dll"));
    await run("mkfifo", [path.join(dir, "pipe.dll")]);
    const socket = path.join(dir, "s.dll");
    await writeFile(path.join(dir, "locked.dll"), "dll");
    await chmod(path.join(dir, "locked.dll"), 0o000);
    const rows: Array<[string, ArchiveRefusal]> = [
      [path.join(dir, "link.dll"), ArchiveRefusal.NotARegularFile],
      [path.join(dir, "pipe.dll"), ArchiveRefusal.NotARegularFile],
      [socket, ArchiveRefusal.NotARegularFile],
      [path.join(dir, "missing.dll"), ArchiveRefusal.MissingFile],
      [path.join(dir, "real.dll", "under-a-file.dll"), ArchiveRefusal.MissingFile],
    ];
    if (process.getuid?.() !== 0) rows.push([path.join(dir, "locked.dll"), ArchiveRefusal.Unreadable]);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      for (const [file, code] of rows) {
        const runtime = { ...windowsInput().runtime, [WindowsRuntimeFile.Gles]: { file } };
        await refused(() => writeWindowsZip(path.join(out, "g.zip"), windowsInput({ runtime })), code, file);
        assert.deepEqual(await readdir(out), []);
      }
    } finally {
      // A listening socket keeps the test process alive, so it closes even when a row fails.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("packs files read from disk exactly", async () => {
    const root = await assetFolder();
    const dir = await tmpDir();
    const exe = path.join(dir, "game.exe");
    await writeFile(exe, noise("disk exe", 70_000));
    const file = path.join(dir, "g.zip");
    const assets = await readAssetTree(path.join(root, "assets"));
    await writeWindowsZip(file, windowsInput({ executable: { file: exe }, assets }));
    const out = path.join(dir, "out");
    await extractArchive(file, ArchiveFormat.Zip, out, { strip: 0, into: "" });
    assert.deepEqual(await readFile(path.join(out, "Space Rocks", "Space Rocks.exe")), noise("disk exe", 70_000));
    assert.equal(await readFile(path.join(out, "Space Rocks", "assets", "sprites", "hero.png"), "utf8"), "hero");
  });
});

describe("files that change after they were found", () => {
  it("refuses an asset whose folder was swapped for a link after the walk, and writes no archive", {
    skip: !POSIX,
  }, async () => {
    for (const write of [
      (file: string, assets: AssetFile[]) => writeWindowsZip(file, windowsInput({ assets })),
      (file: string, assets: AssetFile[]) => writeLinuxTarGz(file, linuxInput({ assets })),
    ]) {
      const root = await assetFolder();
      const outside = await tmpDir();
      await writeFile(path.join(outside, "hero.png"), "outside the game");
      const assets = await readAssetTree(path.join(root, "assets"));
      const sprites = path.join(root, "assets", "sprites");
      await rename(sprites, `${sprites}-moved`);
      await symlink(outside, sprites);
      const out = await tmpDir();
      await refused(() => write(path.join(out, "g"), assets), ArchiveRefusal.NotARegularFile);
      assert.deepEqual(await readdir(out), []);
    }
  });

  it("refuses an asset replaced by another file after the walk", async () => {
    const root = await assetFolder();
    const assets = await readAssetTree(path.join(root, "assets"));
    const level = path.join(root, "assets", "level.json");
    // Written beside it first, so the replacement cannot reuse the old inode.
    await writeFile(`${level}.new`, '{"new":true}');
    await rename(`${level}.new`, level);
    const out = await tmpDir();
    await refused(
      () => writeWindowsZip(path.join(out, "g.zip"), windowsInput({ assets })),
      ArchiveRefusal.NotARegularFile,
    );
    assert.deepEqual(await readdir(out), []);
  });

  it("refuses an asset that is a hard link, found in the walk or pinned on its own", async () => {
    const root = await assetFolder();
    const outside = await tmpDir();
    await writeFile(path.join(outside, "private.txt"), "not the game's");
    await link(path.join(outside, "private.txt"), path.join(root, "assets", "copy.png"));
    await refused(() => readAssetTree(path.join(root, "assets")), ArchiveRefusal.NotARegularFile);
    await refused(() => pinnedFile(path.join(root, "assets", "copy.png")), ArchiveRefusal.NotARegularFile);
  });

  it("refuses a pinned file that gained a second name after it was pinned", async () => {
    const dir = await tmpDir();
    const exe = path.join(dir, "game.exe");
    await writeFile(exe, "MZ");
    const executable = await pinnedFile(exe);
    await link(exe, path.join(dir, "alias.exe"));
    const out = await tmpDir();
    await refused(
      () => writeWindowsZip(path.join(out, "g.zip"), windowsInput({ executable })),
      ArchiveRefusal.NotARegularFile,
    );
    assert.deepEqual(await readdir(out), []);
  });
});

describe("the target file", () => {
  it("never writes through a symlink planted at the archive's name", { skip: !POSIX }, async () => {
    const dir = await tmpDir();
    const outside = await tmpDir();
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "keep me");
    await symlink(victim, path.join(dir, "g.zip"));
    await refused(() => writeWindowsZip(path.join(dir, "g.zip"), windowsInput()), ArchiveRefusal.NotARegularFile);
    assert.equal(await readFile(victim, "utf8"), "keep me");
    assert.ok((await lstat(path.join(dir, "g.zip"))).isSymbolicLink());
    assert.deepEqual(await readdir(dir), ["g.zip"]);
  });

  it("refuses a file that holds a credential Studio holds, naming the file and never the value", async () => {
    const dir = await tmpDir();
    const token = "sk-live-0123456789abcdef";
    const assets = [...ASSETS, { path: "config.txt", content: bytes(`key=${token}`) }];
    const writes = [
      () => writeWindowsZip(path.join(dir, "g.zip"), windowsInput({ assets }), { secretValues: [token] }),
      () => writeLinuxTarGz(path.join(dir, "g.tgz"), linuxInput({ assets }), { secretValues: [token] }),
    ];
    for (const write of writes) {
      await assert.rejects(write, (error: unknown) => {
        assert.ok(error instanceof NativeArchiveError);
        assert.equal(error.code, ArchiveRefusal.SecretFound);
        assert.match(error.message, /config\.txt/);
        assert.ok(!error.message.includes(token));
        return true;
      });
    }
    assert.deepEqual(await readdir(dir), []);
  });
});

/** The README a destination's archive carries, read back with the store's own extractor. */
async function readmeOf(file: string, format: ArchiveFormat, folder: string): Promise<string> {
  const out = path.join(path.dirname(file), `out-${path.basename(file)}`);
  await extractArchive(file, format, out, { strip: 0, into: "" });
  return readFile(path.join(out, folder, README_FILE), "utf8");
}

describe("notices and README", () => {
  it("names every component each destination ships, and every third_party licence", () => {
    const windows = composeNotices(BuildTarget.Windows, "Space Rocks", notices(BuildTarget.Windows));
    const expected = ["ANGLE licence text", "raylib zlib licence", "GLFW zlib licence", "MIT No Attribution"];
    expected.push(
      "mingw-w64 runtime",
      "Apache-2.0 WITH LLVM",
      "stb public domain",
      "enet MIT",
      "third_party/stb/LICENSE",
    );
    for (const text of expected) assert.ok(windows.includes(text), text);
    assert.ok(!windows.includes("SwiftShader"));
    assert.ok(windows.includes("\r\n"));
    const linux = composeNotices(BuildTarget.Linux, "space-rocks", notices(BuildTarget.Linux));
    assert.ok(linux.includes("SwiftShader Apache"));
    assert.ok(linux.includes("Copyright Kristian Hogsberg, MIT"));
    assert.ok(linux.includes("Wayland protocol"));
    assert.ok(!windows.includes("Copyright Kristian Hogsberg"));
    assert.ok(!linux.includes("mingw-w64 runtime"));
    assert.ok(!linux.includes("\r\n"));
  });

  it("refuses an export whose notices miss a component it ships", async () => {
    const dir = await tmpDir();
    const blankRaylib = notices(BuildTarget.Linux).map((n) =>
      n.component === NoticeComponent.Raylib ? { ...n, text: "  \n" } : n,
    );
    const zip = path.join(dir, "g.zip");
    const tgz = path.join(dir, "g.tgz");
    const rows: Array<[string, () => Promise<unknown>]> = [
      [
        "mingw",
        () =>
          writeWindowsZip(zip, windowsInput({ notices: without(BuildTarget.Windows, NoticeComponent.MingwRuntime) })),
      ],
      [
        "angle",
        () => writeWindowsZip(zip, windowsInput({ notices: without(BuildTarget.Windows, NoticeComponent.Angle) })),
      ],
      [
        "swiftshader",
        () => writeLinuxTarGz(tgz, linuxInput({ notices: without(BuildTarget.Linux, NoticeComponent.SwiftShader) })),
      ],
      ["blank raylib", () => writeLinuxTarGz(tgz, linuxInput({ notices: blankRaylib }))],
      [
        "wayland protocols",
        () =>
          writeLinuxTarGz(tgz, linuxInput({ notices: without(BuildTarget.Linux, NoticeComponent.WaylandProtocols) })),
      ],
      [
        "zig runtime (windows)",
        () => writeWindowsZip(zip, windowsInput({ notices: without(BuildTarget.Windows, NoticeComponent.ZigRuntime) })),
      ],
      [
        "zig runtime (linux)",
        () => writeLinuxTarGz(tgz, linuxInput({ notices: without(BuildTarget.Linux, NoticeComponent.ZigRuntime) })),
      ],
    ];
    for (const [label, write] of rows) await refused(write, ArchiveRefusal.MissingNotice, label);
    assert.deepEqual(await readdir(dir), []);
  });
});

describe("the README", () => {
  it("says a copy built on a Mac was not run on Windows or Linux, and drops that once it was", async () => {
    const dir = await tmpDir();
    const notRun = path.join(dir, "not-run.zip");
    const ran = path.join(dir, "ran.zip");
    const linux = path.join(dir, "linux.tgz");
    await writeWindowsZip(notRun, windowsInput());
    await writeWindowsZip(ran, windowsInput({ builtOn: StudioPlatform.Windows, ranOnTarget: true }));
    await writeLinuxTarGz(linux, linuxInput());
    const windowsNotRun = await readmeOf(notRun, ArchiveFormat.Zip, "Space Rocks");
    const windowsRan = await readmeOf(ran, ArchiveFormat.Zip, "Space Rocks");
    const linuxNotRun = await readmeOf(linux, ArchiveFormat.TarGz, "space-rocks");
    assert.match(windowsNotRun, /built on a Mac and has not been run on Windows by Genex/);
    assert.match(windowsNotRun, /SmartScreen/);
    assert.match(windowsNotRun, /More info, then Run anyway/);
    assert.match(windowsNotRun, new RegExp(SUMS_FILE));
    assert.match(windowsNotRun, /Smart App Control/);
    assert.doesNotMatch(windowsRan, /not been run/);
    assert.match(linuxNotRun, /built on a Mac and has not been run on Linux by Genex/);
    for (const line of ["tar -xzf space-rocks-linux-x64.tar.gz", "cd space-rocks", "./space-rocks"]) {
      assert.ok(
        linuxNotRun.split("\n").some((each) => each.trim() === line),
        line,
      );
    }
    for (const fact of [/libxcb/, /Vulkan 1\.1/, /SwiftShader/, /glibc 2\.28/]) assert.match(linuxNotRun, fact);
  });
});

describe("export names from a game's title", () => {
  const ROWS: Array<[string, string, string]> = [
    ["Space Rocks!", "Space Rocks!", "space-rocks"],
    ["  Space   Rocks  ", "Space Rocks", "space-rocks"],
    ['a/b\\c:d*e?f"g<h>i|j', "abcdefghij", "a-b-c-d-e-f-g-h-i-j"],
    ["CON", "CON Game", "con-game"],
    ["nul.txt", "nul Game.txt", "nul-txt"],
    ["Dots...", "Dots", "dots"],
    ["???", "Game", "game"],
    ["", "Game", "game"],
    ["Ёлка", "Ёлка", "game"],
    ["-rf", "rf", "rf"],
    ["x".repeat(100), "x".repeat(64), "x".repeat(64)],
    [`nul.${"x".repeat(60)}`, `nul Game.${"x".repeat(55)}`, `nul-${"x".repeat(60)}`],
    [`${"y".repeat(63)}.z`, "y".repeat(63), "y".repeat(63)],
    ["a\uD800b", "ab", "a-b"],
  ];
  for (const [title, windows, linux] of ROWS) {
    it(`${JSON.stringify(title)} becomes ${JSON.stringify(windows)} and ${JSON.stringify(linux)}, both archive names`, () => {
      assert.equal(windowsExportName(title), windows);
      assert.equal(linuxExportName(title), linux);
      assert.doesNotThrow(() => windowsArchiveItems(windowsInput({ name: windows })));
      assert.doesNotThrow(() => linuxArchiveItems(linuxInput({ name: linux })));
    });
  }
});

describe("one Windows name rule", () => {
  /** Segments on both sides of every rule: what Windows refuses, and look-alikes it holds. */
  const SEGMENTS = [
    "hero.png",
    "con.png",
    "CONIN$",
    "conx.png",
    "COM\u00b9",
    "com10",
    "lpt0.txt",
    "a.",
    "a ",
    " a",
    ".hidden",
    "a:b",
    "a|b",
    "a?b",
    "a*b",
    'a"b',
    "a<b",
    "a>b",
    "a\\b",
    "a\u0001b",
    "a\u007fb",
    "a\u0085b",
    "a\ud800b",
    "\u00e9t\u00e9",
    "x".repeat(255),
    "x".repeat(256),
    "\u00e9".repeat(128),
    ".",
    "..",
    "",
  ];

  for (const segment of SEGMENTS) {
    it(`an archive entry named ${JSON.stringify(segment)} is refused exactly when windows-names refuses it`, () => {
      const refusedByRule = windowsNameProblem(segment) !== null;
      const refusedByArchive = (() => {
        try {
          checkArchivePath(`assets/${segment}`);
          return false;
        } catch (error) {
          assert.ok(error instanceof NativeArchiveError);
          assert.equal(error.code, ArchiveRefusal.UnsafeName);
          return true;
        }
      })();
      assert.equal(refusedByArchive, refusedByRule);
    });
  }
});
