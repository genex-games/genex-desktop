/**
 * A minimal Mach-O writer for admission tests: thin arm64 `MH_EXECUTE` and `MH_DYLIB` images with
 * chosen load commands, plus the hostile shapes a reader must refuse (fat, truncated, a string
 * past its command, a command count past the commands). Pure TypeScript, so the rows that use it
 * run on every platform, the Linux `check` job included. The images carry load commands only: no
 * segment, no code. Nothing here is a valid program; it is exactly what a load-command reader reads.
 *
 * The darwin rows that need a real program build one with {@link macClang}, which only ever runs
 * `xcrun clang` when the developer tools are already there: it never opens Apple's installer.
 */
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `MH_MAGIC_64`, written little-endian as arm64 does. */
export const MH_MAGIC_64 = 0xfeedfacf;
/** The two fat-header magics, written big-endian. */
export const FAT_MAGIC = 0xcafebabe;
export const FAT_MAGIC_64 = 0xcafebabf;
/** `CPU_TYPE_ARM64` and `CPU_TYPE_X86_64`. */
export const CPU_ARM64 = 0x0100000c;
export const CPU_X86_64 = 0x01000007;
/** `MH_EXECUTE`, `MH_DYLIB` and `MH_BUNDLE`. */
export const MachOFile = { Execute: 2, Dylib: 6, Bundle: 8 } as const;

/** The load commands this writer emits. */
export const LoadCommand = {
  LoadDylib: 0xc,
  IdDylib: 0xd,
  LoadWeakDylib: 0x80000018,
  Rpath: 0x8000001c,
  ReexportDylib: 0x8000001f,
  LazyLoadDylib: 0x20,
  LoadUpwardDylib: 0x80000023,
  DyldEnvironment: 0x27,
} as const;
export type LoadCommand = (typeof LoadCommand)[keyof typeof LoadCommand];

/** One load command naming a library, a search path or a dyld variable. */
export interface CommandSpec {
  cmd: LoadCommand;
  value: string;
}

/** An image: its type, CPU and load commands, in file order. */
export interface MachOSpec {
  fileType?: number;
  cpuType?: number;
  commands?: CommandSpec[];
  /** Overrides the header's `ncmds` (an overflow row). */
  ncmds?: number;
}

const HEADER_BYTES = 32;
/** Where each command's string starts: after `dylib_command` (24 bytes) or the 12-byte path commands. */
const STRING_OFFSET: Record<LoadCommand, number> = {
  [LoadCommand.LoadDylib]: 24,
  [LoadCommand.IdDylib]: 24,
  [LoadCommand.LoadWeakDylib]: 24,
  [LoadCommand.ReexportDylib]: 24,
  [LoadCommand.LazyLoadDylib]: 24,
  [LoadCommand.LoadUpwardDylib]: 24,
  [LoadCommand.Rpath]: 12,
  [LoadCommand.DyldEnvironment]: 12,
};

/** One load command's bytes: the fixed part, the NUL-terminated string, padded to 8. */
export function loadCommand(spec: CommandSpec, options: { stringOffset?: number } = {}): Buffer {
  const fixed = STRING_OFFSET[spec.cmd];
  const text = Buffer.from(`${spec.value}\0`, "utf8");
  const size = Math.ceil((fixed + text.length) / 8) * 8;
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(spec.cmd, 0);
  bytes.writeUInt32LE(size, 4);
  bytes.writeUInt32LE(options.stringOffset ?? fixed, 8);
  text.copy(bytes, fixed);
  return bytes;
}

/** A thin Mach-O image (arm64 executable by default) with `spec`'s load commands. */
export function machO(spec: MachOSpec = {}, commands?: Buffer[]): Buffer {
  const body = Buffer.concat(commands ?? (spec.commands ?? []).map((command) => loadCommand(command)));
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(MH_MAGIC_64, 0);
  header.writeUInt32LE(spec.cpuType ?? CPU_ARM64, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(spec.fileType ?? MachOFile.Execute, 12);
  header.writeUInt32LE(spec.ncmds ?? commands?.length ?? spec.commands?.length ?? 0, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body]);
}

/** What a Mac game's executable must say: both ANGLE imports, the one rpath, plus the system libraries. */
export function gameCommands(overrides: { dylibs?: string[]; rpaths?: string[] } = {}): CommandSpec[] {
  const dylibs = overrides.dylibs ?? [
    "@rpath/libEGL.dylib",
    "@rpath/libGLESv2.dylib",
    "/System/Library/Frameworks/Metal.framework/Versions/A/Metal",
    "/usr/lib/libSystem.B.dylib",
  ];
  const rpaths = overrides.rpaths ?? ["@executable_path/../Frameworks"];
  return [
    ...dylibs.map((value) => ({ cmd: LoadCommand.LoadDylib, value })),
    ...rpaths.map((value) => ({ cmd: LoadCommand.Rpath, value })),
  ];
}

/** A dylib with the install name `id` and `imports`. */
export function dylib(id: string, imports: string[] = ["/usr/lib/libSystem.B.dylib"]): Buffer {
  return machO({
    fileType: MachOFile.Dylib,
    commands: [
      { cmd: LoadCommand.IdDylib, value: id },
      ...imports.map((value) => ({ cmd: LoadCommand.LoadDylib, value })),
    ],
  });
}

/** A universal (fat) file holding `slices`, as `lipo` writes one. */
export function fat(slices: Buffer[], magic: number = FAT_MAGIC): Buffer {
  const wide = magic === FAT_MAGIC_64;
  const entry = wide ? 32 : 20;
  const header = Buffer.alloc(8 + entry * slices.length);
  header.writeUInt32BE(magic, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = Math.ceil(header.length / 16384) * 16384;
  const parts: Buffer[] = [header];
  slices.forEach((slice, index) => {
    const at = 8 + entry * index;
    header.writeUInt32BE(slice.readUInt32LE(4), at);
    header.writeUInt32BE(0, at + 4);
    if (wide) {
      header.writeBigUInt64BE(BigInt(offset), at + 8);
      header.writeBigUInt64BE(BigInt(slice.length), at + 16);
      header.writeUInt32BE(14, at + 24);
    } else {
      header.writeUInt32BE(offset, at + 8);
      header.writeUInt32BE(slice.length, at + 12);
      header.writeUInt32BE(14, at + 16);
    }
    const before = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(Buffer.alloc(offset - before), slice);
    offset = Math.ceil((offset + slice.length) / 16384) * 16384;
  });
  return Buffer.concat(parts);
}

/** Where the developer tools put clang: Xcode's toolchain, or the Command Line Tools. */
const CLANG_IN_DEVELOPER_DIR = [
  ["Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "clang"],
  ["usr", "bin", "clang"],
] as const;

/**
 * Why a row that builds a real Mach-O does not run here, or false when `xcrun clang` can run.
 * `xcode-select -p` only prints the developer folder; `xcrun` itself would offer to install the
 * tools on a Mac without them, so it is used only once clang is known to be there.
 */
export function macClangSkip(): string | false {
  if (process.platform !== "darwin") return "not run: building a Mach-O needs a Mac";
  const selected = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" });
  const developer = selected.status === 0 ? selected.stdout.trim() : "";
  const found = developer && CLANG_IN_DEVELOPER_DIR.some((parts) => existsSync(path.join(developer, ...parts)));
  return found ? false : "not run: no developer tools with clang on this Mac";
}

/** Runs `xcrun clang` with `args` (call only after {@link macClangSkip} said false). */
export async function macClang(args: readonly string[]): Promise<void> {
  await execFileAsync("/usr/bin/xcrun", ["clang", ...args]);
}

/** The probe's source: one command per line on the protocol pipe, one JSON answer each. */
const PROBE_SOURCE = path.resolve(import.meta.dirname, "..", "cpp", "sandbox_probe.c");

/** Builds `tests/cpp/sandbox_probe.c` into `dir`; returns the program's path. */
export async function buildProbe(dir: string): Promise<string> {
  const out = path.join(dir, "sandbox-probe");
  const frameworks = ["Metal", "Foundation", "IOKit", "CoreFoundation"].flatMap((name) => ["-framework", name]);
  await macClang(["-O1", "-mmacosx-version-min=13.0", PROBE_SOURCE, "-o", out, ...frameworks, "-lobjc"]);
  return out;
}

/** A run directory as assembly leaves one, holding `program` as the bundle's executable. */
export interface ProbeRunDir {
  runId: string;
  runDir: string;
  bundle: string;
  exe: string;
  state: string;
}

/** `<root>/<runId>` with `bundle/Game.app/Contents/MacOS/game` (a copy of `program`) and `state/`. */
export async function probeRunDir(root: string, program: string): Promise<ProbeRunDir> {
  const runId = randomBytes(8).toString("hex");
  const runDir = path.join(root, runId);
  const bundle = path.join(runDir, "bundle");
  const macos = path.join(bundle, "Game.app", "Contents", "MacOS");
  const state = path.join(runDir, "state");
  await mkdir(macos, { recursive: true, mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const exe = path.join(macos, "game");
  await copyFile(program, exe);
  return { runId, runDir, bundle, exe, state };
}

/** Sends one probe command on the protocol pipe and resolves with its JSON answer. */
export interface ProbePipe {
  ask(command: string): Promise<Record<string, unknown>>;
}

/** A line-by-line conversation with a probe over `pipe` (fd 3 of a started game). */
export function probePipe(pipe: Readable & Writable): ProbePipe {
  const answers: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let held = "";
  pipe.setEncoding("utf8");
  pipe.on("data", (chunk: string) => {
    held += chunk;
    for (let newline = held.indexOf("\n"); newline >= 0; newline = held.indexOf("\n")) {
      const line = held.slice(0, newline);
      held = held.slice(newline + 1);
      const next = waiting.shift();
      if (next) next(line);
      else answers.push(line);
    }
  });
  const nextLine = () =>
    new Promise<string>((resolve) => {
      const line = answers.shift();
      if (line === undefined) waiting.push(resolve);
      else resolve(line);
    });
  return {
    async ask(command) {
      pipe.write(`${command}\n`);
      return JSON.parse(await nextLine()) as Record<string, unknown>;
    },
  };
}
