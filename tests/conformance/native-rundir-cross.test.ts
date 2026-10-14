/**
 * The run directory a Windows or Linux host starts a game from (`substrate/native-rundir-cross.ts`):
 * assembled from an admitted cross build (`admitCrossOutput`) and the store ANGLE the lock pins.
 * Windows writes the very executable bytes admission read and the store's own three DLLs; Linux
 * copies exactly the admitted files and checks the game's digest after the copy; both write the
 * host's files from the store, digest-checked, and copy assets without following a link. Every
 * hostile row asserts the typed refusal and that no run directory is left (or that an existing one
 * is untouched). Real rows assemble the head start's zig-built packages when present (required
 * under `GENEX_REQUIRE_TOOLCHAINS=1`).
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { NativeError, NativeRefusal } from "../../src/shared/native-contract.ts";
import { ToolchainHost, ToolchainId } from "../../src/shared/toolchain.ts";
import {
  admitCrossOutput,
  type CrossAdmission,
  type CrossAngle,
  type DesktopTarget,
} from "../../src/substrate/native-cross-admission.ts";
import { LINUX_HOST_FILES } from "../../src/substrate/native-gate-elf.ts";
import { readPe, WindowsAngleDll } from "../../src/substrate/native-gate-pe.ts";
import { assembleCrossRunDir } from "../../src/substrate/native-rundir-cross.ts";
import { manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { devCrossPackage, devTool, needsCrossPackage, needsTools } from "../helpers/dev-toolchains.ts";
import { writeElf } from "../helpers/elf.ts";
import { writePe } from "../helpers/pe.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const POSIX = process.platform !== "win32";
const RUN_ID = "0123456789abcdef";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const ANGLE_DLLS: Record<WindowsAngleDll, Uint8Array> = {
  [WindowsAngleDll.Egl]: writePe({ dll: true, imports: ["KERNEL32.dll"], exports: ["eglGetProcAddress"] }).bytes,
  [WindowsAngleDll.Gles]: writePe({ dll: true, imports: ["KERNEL32.dll", "dxgi.dll"], exports: ["glClear"] }).bytes,
  [WindowsAngleDll.D3dCompiler]: writePe({ dll: true, imports: ["KERNEL32.dll"], exports: ["D3DCompile"] }).bytes,
};
const WINDOWS_GAME = writePe({ imports: ["libGLESv2.dll", "KERNEL32.dll", "USER32.dll", "WINMM.dll"] }).bytes;
const LINUX_GAME = writeElf().bytes;
const LINUX_HOST: Record<string, Uint8Array> = Object.fromEntries(
  LINUX_HOST_FILES.map((name) => [name, Buffer.from(`store ${name}\n`)]),
);
const EXE = { [BuildTarget.Windows]: "game.exe", [BuildTarget.Linux]: "game" } as const;
/** A file that is a program for each destination: what an asset must never become. */
const PROGRAM = { [BuildTarget.Windows]: writePe({ dll: true }).bytes, [BuildTarget.Linux]: LINUX_GAME } as const;
/** What a host-written copy of a store file must never be confused with: other bytes under its name. */
const TAMPERED = Buffer.from("tampered after admission");

/** Everything under `root` without following a link: kind, size, mode, mtime and digest. */
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
      } else if (info.isFile()) out[rel] = `file ${info.mode} ${info.mtimeMs} ${sha256(await readFile(full))}`;
      else out[rel] = `other ${info.mode}`;
    }
  };
  await walk(root);
  return out;
}

/** Every file under `dir` as a sorted `/`-separated path with its digest. */
async function fileDigests(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of (await readdir(dir, { recursive: true })).sort()) {
    const full = path.join(dir, rel);
    if ((await lstat(full)).isFile()) out[rel.split(path.sep).join("/")] = sha256(await readFile(full));
  }
  return out;
}

/** A pinned store ANGLE folder in the ANGLE manifest format: its files and the manifest's own digest. */
async function storeAngle(base: string, files: Record<string, Uint8Array>): Promise<CrossAngle> {
  const dir = path.join(base, "angle");
  await mkdir(dir);
  const listed: Record<string, { sha256: string; size: number }> = {};
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(dir, name), bytes);
    listed[name] = { sha256: sha256(bytes), size: bytes.byteLength };
  }
  const manifest = `${JSON.stringify({ schema: 1, files: listed }, null, 2)}\n`;
  await writeFile(path.join(dir, "manifest.json"), manifest);
  return { dir, manifestSha256: sha256(manifest) };
}

/** One destination's world: the store ANGLE, a build's `out/`, the native-runs root, and the admission. */
interface World {
  target: DesktopTarget;
  base: string;
  out: string;
  root: string;
  angle: CrossAngle;
  admitted: Extract<CrossAdmission, { ok: true }>;
}

/** A build's `out/` for `target`, as the lane leaves it, admitted against the store ANGLE. */
async function world(target: DesktopTarget, arrange?: (out: string) => Promise<void>): Promise<World> {
  const base = await tmpDir("rundir-cross-");
  const out = path.join(base, "out");
  await mkdir(path.join(out, "assets", "levels"), { recursive: true });
  await writeFile(path.join(out, "assets", "sprite.png"), "png");
  await writeFile(path.join(out, "assets", "levels", "one.json"), "{}");
  const windows = target === BuildTarget.Windows;
  await writeFile(path.join(out, EXE[target]), windows ? WINDOWS_GAME : LINUX_GAME);
  const store: Record<string, Uint8Array> = windows ? ANGLE_DLLS : LINUX_HOST;
  const supplied = windows ? WindowsAngleDll.Egl : "libEGL.so";
  await writeFile(path.join(out, supplied), store[supplied] as Uint8Array);
  if (windows) await writeFile(path.join(out, "libGLESv2.dll.lib"), "!<arch>\n");
  await arrange?.(out);
  const angle = await storeAngle(base, store);
  const admission = await admitCrossOutput({ target, out, angle });
  assert.ok(admission.ok, admission.ok ? "" : `${admission.refusal} ${admission.file}: ${admission.detail}`);
  return { target, base, out, root: path.join(base, "runs"), angle, admitted: admission };
}

const assemble = (w: World, runId = RUN_ID) =>
  assembleCrossRunDir({ root: w.root, runId, admitted: w.admitted, angle: w.angle });

/** Asserts `work` is refused with `refusal` (a `NativeError`). */
async function assertRefused(work: Promise<unknown>, refusal: NativeRefusal): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof NativeError, String(error));
    assert.equal(error.refusal, refusal, error.message);
    return true;
  });
}

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** Asserts no run directory is left: `root` holds nothing (or was never made). */
async function assertNoRunDir(w: World): Promise<void> {
  assert.equal(await exists(path.join(w.root, RUN_ID)), false, "a run directory was left behind");
  if (await exists(w.root)) assert.deepEqual(await readdir(w.root), []);
}

const TARGETS: readonly DesktopTarget[] = [BuildTarget.Windows, BuildTarget.Linux];

describe("Windows: the run directory a Windows host starts the game from", () => {
  it("holds the admitted game, the store's three DLLs and the assets, and a state folder", async () => {
    const w = await world(BuildTarget.Windows);
    const before = await snapshot(w.out);
    const run = await assemble(w);
    const runDir = path.join(await realpath(w.root), RUN_ID);
    assert.deepEqual(run, {
      runDir,
      exe: await realpath(path.join(runDir, "bundle", "game.exe")),
      bundle: path.join(runDir, "bundle"),
      state: path.join(runDir, "state"),
    });
    assert.deepEqual(await fileDigests(run.bundle), {
      "assets/levels/one.json": sha256("{}"),
      "assets/sprite.png": sha256("png"),
      "d3dcompiler_47.dll": sha256(ANGLE_DLLS[WindowsAngleDll.D3dCompiler]),
      "game.exe": sha256(WINDOWS_GAME),
      "libEGL.dll": sha256(ANGLE_DLLS[WindowsAngleDll.Egl]),
      "libGLESv2.dll": sha256(ANGLE_DLLS[WindowsAngleDll.Gles]),
    });
    assert.deepEqual((await readdir(run.state)).sort(), ["captures", "home"]);
    if (POSIX) assert.equal((await lstat(runDir)).mode & 0o777, 0o700);
    assert.deepEqual(await snapshot(w.out), before, "assembly wrote into out/");
  });

  it("writes the bytes admission read, never re-reading out/game.exe or the build's own ANGLE copy", async () => {
    const w = await world(BuildTarget.Windows);
    await writeFile(path.join(w.out, "game.exe"), writePe({ imports: ["libGLESv2.dll", "opengl32.dll"] }).bytes);
    await writeFile(path.join(w.out, WindowsAngleDll.Egl), TAMPERED);
    const run = await assemble(w);
    const digests = await fileDigests(run.bundle);
    assert.equal(digests["game.exe"], sha256(WINDOWS_GAME));
    assert.equal(digests[WindowsAngleDll.Egl], sha256(ANGLE_DLLS[WindowsAngleDll.Egl]));
  });

  it("keeps an assets folder's on-disk spelling (Assets/)", async () => {
    const base = await world(BuildTarget.Windows, async (out) => {
      await rm(path.join(out, "assets"), { recursive: true });
      await mkdir(path.join(out, "Assets"));
      await writeFile(path.join(out, "Assets", "Sprite.png"), "png");
    });
    const run = await assemble(base);
    assert.deepEqual(
      Object.keys(await fileDigests(run.bundle)).filter((file) => file.includes("/")),
      ["Assets/Sprite.png"],
    );
  });

  for (const name of Object.values(WindowsAngleDll)) {
    it(`refuses a store ${name} that differs from its pin, leaving no run directory`, async () => {
      const w = await world(BuildTarget.Windows);
      await writeFile(path.join(w.angle.dir, name), TAMPERED);
      await assertRefused(assemble(w), NativeRefusal.AngleDigest);
      await assertNoRunDir(w);
    });
  }

  it("refuses a store DLL that is a link to the pinned bytes, leaving no run directory", { skip: !POSIX }, async () => {
    const w = await world(BuildTarget.Windows);
    const copy = path.join(w.base, "elsewhere.dll");
    await writeFile(copy, ANGLE_DLLS[WindowsAngleDll.Gles]);
    await rm(path.join(w.angle.dir, WindowsAngleDll.Gles));
    await symlink(copy, path.join(w.angle.dir, WindowsAngleDll.Gles));
    await assertRefused(assemble(w), NativeRefusal.AngleDigest);
    await assertNoRunDir(w);
  });
});

describe("Linux: the run directory a Linux host starts the game from", () => {
  it("holds exactly the admitted files, the game 0755 and digest-checked, and the store's host files at the root", async () => {
    const w = await world(BuildTarget.Linux);
    const before = await snapshot(w.out);
    const run = await assemble(w);
    const runDir = path.join(await realpath(w.root), RUN_ID);
    assert.equal(run.exe, await realpath(path.join(runDir, "bundle", "game")));
    assert.deepEqual(await fileDigests(run.bundle), {
      "assets/levels/one.json": sha256("{}"),
      "assets/sprite.png": sha256("png"),
      game: sha256(LINUX_GAME),
      ...Object.fromEntries(LINUX_HOST_FILES.map((name) => [name, sha256(LINUX_HOST[name] as Uint8Array)])),
    });
    if (POSIX) {
      assert.equal((await lstat(run.exe)).mode & 0o777, 0o755);
      assert.equal((await lstat(runDir)).mode & 0o777, 0o700);
    }
    assert.deepEqual((await readdir(run.state)).sort(), ["captures", "home"]);
    assert.deepEqual(await snapshot(w.out), before, "assembly wrote into out/");
  });

  it("writes the store's host files over the build's admitted copies, never reading those", async () => {
    const w = await world(BuildTarget.Linux);
    await writeFile(path.join(w.out, "libEGL.so"), TAMPERED);
    const run = await assemble(w);
    assert.equal((await fileDigests(run.bundle))["libEGL.so"], sha256(LINUX_HOST["libEGL.so"] as Uint8Array));
  });

  it("refuses a game changed after admission, leaving no run directory", async () => {
    const w = await world(BuildTarget.Linux);
    await writeFile(path.join(w.out, "game"), writeElf({ needed: ["libGLESv2.so", "libGL.so.1", "libc.so.6"] }).bytes);
    await assertRefused(assemble(w), NativeRefusal.NotAnExecutable);
    await assertNoRunDir(w);
  });

  for (const name of LINUX_HOST_FILES) {
    it(`refuses a store ${name} that differs from its pin, leaving no run directory`, async () => {
      const w = await world(BuildTarget.Linux);
      await writeFile(path.join(w.angle.dir, name), TAMPERED);
      await assertRefused(assemble(w), NativeRefusal.AngleDigest);
      await assertNoRunDir(w);
    });
  }
});

/** A change to `out/` after admission that assembly must refuse, and the refusal. */
interface SwapRow {
  name: string;
  posixOnly?: boolean;
  swap: (out: string, w: World) => Promise<void>;
  refusal: (target: DesktopTarget) => NativeRefusal;
}

const SWAPS: SwapRow[] = [
  {
    name: "an asset swapped for a link",
    posixOnly: true,
    swap: async (out, w) => {
      const secret = path.join(w.base, "secret.png");
      await writeFile(secret, "secret");
      await rm(path.join(out, "assets", "sprite.png"));
      await symlink(secret, path.join(out, "assets", "sprite.png"));
    },
    refusal: () => NativeRefusal.Symlink,
  },
  {
    name: "an asset folder swapped for a link",
    posixOnly: true,
    swap: async (out, w) => {
      const elsewhere = path.join(w.base, "elsewhere");
      await mkdir(elsewhere);
      await writeFile(path.join(elsewhere, "one.json"), "{}");
      await rm(path.join(out, "assets", "levels"), { recursive: true });
      await symlink(elsewhere, path.join(out, "assets", "levels"));
    },
    refusal: () => NativeRefusal.Symlink,
  },
  {
    name: "an asset given a second hard link",
    swap: async (out, w) => link(path.join(out, "assets", "sprite.png"), path.join(w.base, "sprite-twin.png")),
    refusal: () => NativeRefusal.HardLink,
  },
  {
    name: "an asset turned into a program",
    swap: async (out, w) => writeFile(path.join(out, "assets", "sprite.png"), PROGRAM[w.target]),
    refusal: (target) => (target === BuildTarget.Windows ? NativeRefusal.ExtraPe : NativeRefusal.ExtraSharedObject),
  },
  {
    name: "an asset swapped for a FIFO",
    posixOnly: true,
    swap: async (out) => {
      await rm(path.join(out, "assets", "sprite.png"));
      execFileSync("/usr/bin/mkfifo", [path.join(out, "assets", "sprite.png")]);
    },
    refusal: () => NativeRefusal.NotAnExecutable,
  },
  {
    name: "an asset removed",
    swap: async (out) => rm(path.join(out, "assets", "sprite.png")),
    refusal: () => NativeRefusal.NotAnExecutable,
  },
  {
    // A process the build left behind can rename out/ away and put a link at its name: every
    // copy would then be read through the link, its folder's files standing in for the admitted ones.
    name: "out/ itself swapped for a link to a folder with the same names",
    posixOnly: true,
    swap: async (out, w) => {
      const elsewhere = path.join(w.base, "elsewhere");
      await cp(out, elsewhere, { recursive: true });
      await writeFile(path.join(elsewhere, "assets", "sprite.png"), "SECRET KEY");
      await rename(out, path.join(w.base, "out-admitted"));
      await symlink(elsewhere, out);
    },
    refusal: () => NativeRefusal.Symlink,
  },
  {
    name: "out/ itself replaced by another folder with the same names",
    swap: async (out, w) => {
      const admitted = path.join(w.base, "out-admitted");
      await rename(out, admitted);
      await cp(admitted, out, { recursive: true });
      await writeFile(path.join(out, "assets", "sprite.png"), "SECRET KEY");
    },
    refusal: () => NativeRefusal.Symlink,
  },
];

describe("both destinations: what changed after admission, and the run directory's name", () => {
  for (const target of TARGETS) {
    for (const row of SWAPS) {
      it(`${target}: refuses ${row.name} after the walk, leaving no run directory`, {
        skip: row.posixOnly && !POSIX,
      }, async () => {
        const w = await world(target);
        await row.swap(w.out, w);
        await assertRefused(assemble(w), row.refusal(target));
        await assertNoRunDir(w);
      });
    }

    it(`${target}: refuses a run directory that exists already, leaving it untouched`, async () => {
      const w = await world(target);
      const taken = path.join(w.root, RUN_ID);
      await mkdir(path.join(taken, "bundle"), { recursive: true });
      await writeFile(path.join(taken, "bundle", "keep.txt"), "someone else's run");
      const before = await snapshot(w.root);
      await assertRefused(assemble(w), NativeRefusal.Unsupported);
      assert.deepEqual(await snapshot(w.root), before);
    });

    for (const runId of ["../x", "ABC", "0".repeat(33), "", "0123456789ab/", "0123456789AB"]) {
      it(`${target}: refuses the run id ${JSON.stringify(runId)} with nothing written`, async () => {
        const w = await world(target);
        const before = await snapshot(w.base);
        await assertRefused(assemble(w, runId), NativeRefusal.Unsupported);
        assert.deepEqual(await snapshot(w.base), before);
        assert.equal(await exists(w.root), false);
      });
    }
  }
});

/** The lock's store ANGLE for a destination, as the toolchain manifest pins it. */
function pinnedStoreAngle(target: DesktopTarget): CrossAngle {
  const id = target === BuildTarget.Windows ? ToolchainId.AngleWindows : ToolchainId.AngleLinux;
  const tool = devTool(target === BuildTarget.Windows ? "angleWindows" : "angleLinux");
  const pin = manifestEntry(id, ToolchainHost.MacArm64)?.local?.manifestSha256;
  if ("skip" in tool || !pin) throw new Error(`no ${id} folder or pin`);
  return { dir: tool.path, manifestSha256: pin };
}

/** The head start's real package for a destination. */
function realPackage(target: DesktopTarget): string {
  const found = devCrossPackage(target);
  if ("skip" in found) throw new Error(found.skip);
  return found.path;
}

describe("the head start's real cross packages", () => {
  for (const target of TARGETS) {
    const tool = target === BuildTarget.Windows ? "angleWindows" : "angleLinux";
    it(`${target}: admits and assembles the zig-built starter: the package's files, byte for byte`, {
      ...needsTools(tool),
      ...needsCrossPackage(target),
    }, async () => {
      const out = realPackage(target);
      const angle = pinnedStoreAngle(target);
      const before = await snapshot(out);
      const admitted = await admitCrossOutput({ target, out, angle });
      assert.ok(admitted.ok, admitted.ok ? "" : admitted.detail);
      const root = path.join(await tmpDir("rundir-cross-real-"), "runs");
      const run = await assembleCrossRunDir({ root, runId: RUN_ID, admitted, angle });
      assert.deepEqual(await fileDigests(run.bundle), await fileDigests(out));
      for (const [name, digest] of Object.entries(await fileDigests(run.bundle))) {
        if (name === EXE[target]) continue;
        assert.equal(sha256(await readFile(path.join(angle.dir, name))), digest, `${name} is the store's own copy`);
      }
      if (POSIX && target === BuildTarget.Linux) assert.equal((await lstat(run.exe)).mode & 0o777, 0o755);
      assert.deepEqual(await snapshot(out), before, "assembly wrote into the package");
    });
  }

  it("windows: llvm-readobj --coff-imports lists exactly the imports the gate read from the real game.exe", {
    ...needsTools("llvmMingw"),
    ...needsCrossPackage(BuildTarget.Windows),
  }, async () => {
    const mingw = devTool("llvmMingw");
    if ("skip" in mingw) return;
    const exe = path.join(realPackage(BuildTarget.Windows), "game.exe");
    const { stdout } = await execFileAsync(path.join(mingw.path, "bin", "llvm-readobj"), ["--coff-imports", exe]);
    const lines = stdout.split("\n").map((line) => line.trim());
    const listed: Record<string, string[]> = { Import: [], DelayImport: [] };
    for (const [index, line] of lines.entries()) {
      const table = /^(Import|DelayImport) \{$/.exec(line)?.[1];
      const name = /^Name: (.+)$/.exec(lines[index + 1] ?? "")?.[1];
      if (table && name) listed[table]?.push(name);
    }
    const read = readPe(await readFile(exe));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepEqual(read.image.imports, listed.Import);
    assert.deepEqual(read.image.delayImports, listed.DelayImport);
    assert.ok(read.image.imports.includes("libGLESv2.dll"));
  });
});
