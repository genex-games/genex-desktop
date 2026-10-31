/**
 * The player builds a game folder holds, read from the binaries themselves: a Mac app's processors
 * from its Mach-O header, a Windows program's from its PE header, a Linux program's from its ELF one. The folder is written by agents:
 * a bundle reached through a link, a program that is a link or leads out of its bundle, a bundle
 * with no program, a file that only claims to be a program and an engine's cache are never builds.
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { elfArch, findNativeBuilds, machOArch, machOProcessors, peArch } from "../../src/main/core/native-builds.ts";
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

/** A fat Mach-O header of 64-bit entries (`fat_arch_64`) carrying `cpus`. */
function fat64MachO(cpus: number[]): Buffer {
  const bytes = Buffer.alloc(8 + cpus.length * 32 + 16);
  bytes.writeUInt32BE(0xcafebabf, 0);
  bytes.writeUInt32BE(cpus.length, 4);
  cpus.forEach((cpu, at) => bytes.writeUInt32BE(cpu, 8 + at * 32));
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

/** An ELF header: 64-bit little-endian unless said, of `type` (2 a program, 3 position-independent, 1 an object). */
function elf(machine: number, { type = 3, bits = 2 }: { type?: number; bits?: number } = {}): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = bits;
  bytes[5] = 1;
  bytes.writeUInt16LE(type, 16);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}
const ELF_X64 = 0x3e;
const ELF_ARM64 = 0xb7;

/** `file` with `bytes`, its folders made. */
async function put(file: string, bytes: Buffer | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
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

  it("reads a Linux program as Unity, Godot and Unreal lay it out, and ships its whole build", async () => {
    const root = await tmpDir("native-builds-");
    // Unity: the player beside its data and engine library (an ELF too, never the game).
    await put(path.join(root, "unity", "Builds", "Linux", "Dust.x86_64"), elf(ELF_X64, { type: 2 }));
    await put(path.join(root, "unity", "Builds", "Linux", "UnityPlayer.so"), elf(ELF_X64));
    await mkdir(path.join(root, "unity", "Builds", "Linux", "Dust_Data"), { recursive: true });
    // Godot: an Arm build with its pack.
    await put(path.join(root, "Builds", "LinuxArm", "Dust.arm64"), elf(ELF_ARM64));
    await put(path.join(root, "Builds", "LinuxArm", "Dust.pck"), "GDPC");
    // Unreal: the game's program under its package, beside its symbols; the engine's own programs.
    const pack = path.join(root, "Packaged", "Linux");
    await put(path.join(pack, "Dust.sh"), "#!/bin/sh\n");
    await put(path.join(pack, "Dust", "Binaries", "Linux", "Dust-Linux-Shipping"), elf(ELF_X64));
    await put(path.join(pack, "Dust", "Binaries", "Linux", "Dust-Linux-Shipping.debug"), elf(ELF_X64));
    await put(path.join(pack, "Dust", "Binaries", "Linux", "libsteam_api.so"), elf(ELF_X64));
    await put(path.join(pack, "Engine", "Binaries", "Linux", "CrashReportClient"), elf(ELF_X64));
    await put(path.join(pack, "Engine", "Binaries", "Linux", "UnrealGame"), elf(ELF_X64));
    const found = await findNativeBuilds(root);
    assert.deepEqual(found.map((build) => [build.platform, build.arch, build.entry, build.folder]).sort(), [
      [NativePlatform.Linux, NativeArch.Arm64, "Builds/LinuxArm/Dust.arm64", "Builds/LinuxArm"],
      [
        NativePlatform.Linux,
        NativeArch.X64,
        "Packaged/Linux/Dust/Binaries/Linux/Dust-Linux-Shipping",
        "Packaged/Linux",
      ],
      [NativePlatform.Linux, NativeArch.X64, "unity/Builds/Linux/Dust.x86_64", "unity/Builds/Linux"],
    ]);
    const unreal = found.find((build) => build.folder === "Packaged/Linux");
    const binaries = found.find((build) => build.folder === "Builds/LinuxArm");
    assert.ok((unreal?.bytes ?? 0) > (binaries?.bytes ?? 0), "an Unreal package counts its engine and data too");
  });

  it("reads an Unreal Windows package as one build: its starter at the package's root", async () => {
    const root = await tmpDir("native-builds-");
    const pack = path.join(root, "unreal", "Builds", "Windows");
    await put(path.join(pack, "Dust", "Binaries", "Win64", "Dust-Win64-Shipping.exe"), pe(0x8664));
    await put(path.join(pack, "Engine", "Binaries", "Win64", "CrashReportClient.exe"), pe(0x8664));
    await put(path.join(pack, "Engine", "Binaries", "Win64", "EpicWebHelper.exe"), pe(0x8664));
    await put(path.join(pack, "Engine", "Extras", "Redist", "en-us", "UEPrereqSetup_x64.exe"), pe(0x8664));
    await put(path.join(pack, "Dust", "Content", "Paks", "Dust-Windows.pak"), "pak");
    // The starter UAT writes last, at the package's root: what a player runs.
    await put(path.join(pack, "Dust.exe"), pe(0x8664));
    const found = await findNativeBuilds(root);
    assert.deepEqual(
      found.map((build) => [build.platform, build.arch, build.entry, build.folder]),
      [[NativePlatform.Windows, NativeArch.X64, "unreal/Builds/Windows/Dust.exe", "unreal/Builds/Windows"]],
    );
  });

  it("never takes an Unreal project's own build output for a build: it has no game content", async () => {
    const root = await tmpDir("native-builds-");
    const project = path.join(root, "unreal");
    await put(path.join(project, "Dust.uproject"), "{}");
    // UnrealBuildTool's program, before staging: no cooked content beside it.
    await app(path.join(project, "Binaries", "Mac"), "Dust-Mac-Shipping", thinMachO(CPU_ARM64), "Dust-Mac-Shipping");
    await put(path.join(project, "Binaries", "Win64", "Dust-Win64-Shipping.exe"), pe(0x8664));
    await app(path.join(project, "Builds", "Mac"), "Dust-Mac-Shipping", thinMachO(CPU_ARM64), "Dust-Mac-Shipping");
    const found = await findNativeBuilds(root);
    assert.deepEqual(
      found.map((build) => build.entry),
      ["unreal/Builds/Mac/Dust-Mac-Shipping.app"],
    );
  });

  it("finds no Linux build in what only looks like one", async () => {
    const root = await tmpDir("native-builds-");
    const outside = await tmpDir("native-builds-outside-");
    await put(path.join(outside, "Far.x86_64"), elf(ELF_X64));
    await mkdir(path.join(root, "Builds", "Linked"), { recursive: true });
    await symlink(path.join(outside, "Far.x86_64"), path.join(root, "Builds", "Linked", "Far.x86_64"));
    await symlink(outside, path.join(root, "Builds", "LinkedFolder"));
    await put(path.join(root, "Builds", "Script", "run.x86_64"), "#!/bin/sh\necho not a program\n");
    await put(path.join(root, "Builds", "Old", "Dust.x86_64"), elf(ELF_X64, { bits: 1 }));
    await put(path.join(root, "Builds", "Object", "Dust.x86_64"), elf(ELF_X64, { type: 1 }));
    await put(path.join(root, "Builds", "Risc", "Dust.x86_64"), elf(0xf3));
    // A tool's own program, named as any program is: never a game.
    await put(path.join(root, "venv", "bin", "python3"), elf(ELF_X64, { type: 2 }));
    // A program at the game folder's root: its folder would be the whole game.
    await put(path.join(root, "Dust.x86_64"), elf(ELF_X64));
    await put(path.join(root, ".godot", "exported", "Dust.x86_64"), elf(ELF_X64));
    assert.deepEqual(await findNativeBuilds(root), []);
  });

  it("reads a Mac program's processors from its header alone, and nothing from one cut short or made up", async () => {
    const root = await tmpDir("native-builds-");
    const i386 = Buffer.alloc(28);
    i386.writeUInt32LE(0xfeedface, 0);
    i386.writeUInt32LE(7, 4);
    const java = Buffer.from("cafebabe00000034", "hex");
    const fatOfTwoWithOne = fatMachO([CPU_ARM64, CPU_X86_64]).subarray(0, 8 + 20);
    const fatOfMany = fatMachO([CPU_ARM64]);
    fatOfMany.writeUInt32BE(0xffffffff, 4);
    const cases: Array<[string, Buffer, readonly string[] | null]> = [
      ["thin Apple silicon", thinMachO(CPU_ARM64), [NativeArch.Arm64]],
      ["thin Intel", thinMachO(CPU_X86_64), [NativeArch.X64]],
      ["universal", fatMachO([CPU_X86_64, CPU_ARM64]), [NativeArch.Arm64, NativeArch.X64]],
      ["universal of 64-bit fat entries", fat64MachO([CPU_ARM64]), [NativeArch.Arm64]],
      ["fat with no processor Genex knows (PowerPC, i386)", fatMachO([0x12, 7]), []],
      ["thin 32-bit i386", i386, []],
      ["a thin header cut short", thinMachO(CPU_ARM64).subarray(0, 20), null],
      ["only the magic", thinMachO(CPU_ARM64).subarray(0, 4), null],
      ["a fat header listing two, holding one", fatOfTwoWithOne, null],
      ["a fat header listing none", fatMachO([]), null],
      ["a fat header listing more than any program has", fatOfMany, null],
      ["a Java class, which starts as a fat header does", java, null],
      ["words", Buffer.from("#!/bin/sh\necho not a program\n"), null],
      ["nothing", Buffer.alloc(0), null],
    ];
    for (const [why, bytes, processors] of cases) {
      const file = path.join(root, why.replace(/\W+/g, "-"));
      await writeFile(file, bytes);
      assert.deepEqual(await machOProcessors(file), processors, why);
    }
    assert.equal(await machOProcessors(path.join(root, "missing")), null, "a file that is not there");
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
    assert.equal(await elfArch(text), null);
    const tux = path.join(root, "Dust.x86_64");
    await writeFile(tux, elf(ELF_ARM64, { type: 2 }));
    assert.equal(await elfArch(tux), NativeArch.Arm64);
  });
});
