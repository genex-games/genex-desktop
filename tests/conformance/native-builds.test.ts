/**
 * The player builds a game folder holds, read from the binaries themselves: a Mac app's processors
 * from its Mach-O header, a Windows program's from its PE header. The folder is written by agents:
 * a bundle reached through a link, a program that is a link or leads out of its bundle, a bundle
 * with no program, a file that only claims to be a program and an engine's cache are never builds.
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { findNativeBuilds, machOArch, peArch } from "../../src/main/core/native-builds.ts";
import { NativeArch, NativePlatform } from "../../src/shared/play-native.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

/** A thin 64-bit Mach-O header for `cpu`, padded like a program. */
function thinMachO(cpu: number): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpu, 4);
  return bytes;
}

/** A fat Mach-O header carrying `cpus`. */
function fatMachO(cpus: number[]): Buffer {
  const bytes = Buffer.alloc(8 + cpus.length * 20 + 16);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, at) => bytes.writeUInt32BE(cpu, 8 + at * 20));
  return bytes;
}

/** A PE program's headers for `machine`. */
function pe(machine: number): Buffer {
  const bytes = Buffer.alloc(256);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "latin1");
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

const PLIST = (program: string) =>
  `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${program}</string></dict></plist>`;

/** A Mac app at `dir/name.app` whose program holds `binary`. */
async function app(dir: string, name: string, binary: Buffer, program = "Game"): Promise<string> {
  const bundle = path.join(dir, `${name}.app`);
  await mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(bundle, "Contents", "Info.plist"), PLIST(program));
  if (!program.includes("/")) await writeFile(path.join(bundle, "Contents", "MacOS", program), binary);
  return bundle;
}

describe("a game folder's player builds", () => {
  it("reads a Mac app's processors and a Windows program's from their headers", async () => {
    const root = await tmpDir("native-builds-");
    await app(path.join(root, "Builds", "Mac"), "Dust Runners", fatMachO([CPU_ARM64, CPU_X86_64]));
    await app(path.join(root, "unity", "Builds", "Arm"), "Dust Runners Arm", thinMachO(CPU_ARM64));
    const win = path.join(root, "Builds", "Windows");
    await mkdir(path.join(win, "DustRunners_Data"), { recursive: true });
    await writeFile(path.join(win, "UnityCrashHandler64.exe"), pe(0x8664));
    await writeFile(path.join(win, "DustRunners.exe"), pe(0x8664));
    const found = await findNativeBuilds(root);
    const seen = found.map((build) => [build.platform, build.arch, build.entry]).sort();
    assert.deepEqual(seen, [
      [NativePlatform.Mac, NativeArch.Arm64, "unity/Builds/Arm/Dust Runners Arm.app"],
      [NativePlatform.Mac, NativeArch.Universal, "Builds/Mac/Dust Runners.app"],
      [NativePlatform.Windows, NativeArch.X64, "Builds/Windows/DustRunners.exe"],
    ]);
    assert.ok(found.every((build) => build.bytes > 0 && build.builtAt > 0));
  });

  it("finds no build in what only looks like one", async () => {
    const root = await tmpDir("native-builds-");
    const outside = await tmpDir("native-builds-outside-");
    const real = await app(outside, "Elsewhere", thinMachO(CPU_ARM64));
    await mkdir(path.join(root, "Builds"), { recursive: true });
    await symlink(real, path.join(root, "Builds", "Linked.app"));
    const linkedProgram = await app(path.join(root, "a"), "Program Link", Buffer.alloc(0), "Game");
    await writeFile(path.join(linkedProgram, "Contents", "MacOS", "Game"), "");
    await mkdir(path.join(root, "b", "Linked Folder.app", "Contents"), { recursive: true });
    await writeFile(path.join(root, "b", "Linked Folder.app", "Contents", "Info.plist"), PLIST("Game"));
    await symlink(path.join(real, "Contents", "MacOS"), path.join(root, "b", "Linked Folder.app", "Contents", "MacOS"));
    await mkdir(path.join(root, "c", "Fake.app", "Contents"), { recursive: true });
    await app(path.join(root, "d"), "Climb", thinMachO(CPU_ARM64), "../../../evil");
    await app(path.join(root, "e"), "Text", Buffer.from("#!/bin/sh\necho not a program\n"));
    await mkdir(path.join(root, "f"), { recursive: true });
    await writeFile(path.join(root, "f", "Game.exe"), "MZ but no PE header follows this text at all");
    await app(path.join(root, "node_modules", "pkg"), "Cached", thinMachO(CPU_ARM64));
    await app(path.join(root, "1", "2", "3", "4", "5", "6", "7", "8"), "Deep", thinMachO(CPU_ARM64));
    assert.deepEqual(await findNativeBuilds(root), []);
  });

  it("answers the header readers nothing for a file that is not a program", async () => {
    const root = await tmpDir("native-builds-");
    const text = path.join(root, "notes.txt");
    await writeFile(text, "plain words");
    assert.equal(await machOArch(text), null);
    assert.equal(await peArch(text), null);
    const arm = path.join(root, "arm.exe");
    await writeFile(arm, pe(0xaa64));
    assert.equal(await peArch(arm), NativeArch.Arm64);
    const x86 = path.join(root, "old.exe");
    await writeFile(x86, pe(0x14c));
    assert.equal(await peArch(x86), null, "a 32-bit program is not a build Genex installs");
  });
});
