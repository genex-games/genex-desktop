/**
 * The player builds a game folder holds: a Mac app (a `.app` with an Info.plist and a Mach-O program
 * inside), a Windows program (a PE `.exe` beside its data) and a Linux program (a 64-bit ELF named
 * as Unity and Godot name it, `<Game>.x86_64`, or in an Unreal package's `<Game>/Binaries/Linux`),
 * wherever Unity, Godot or Unreal put them (never an Unreal project's own `Binaries`, which hold no game content). Platform and processor are read from the binary itself, never from a name or the author's
 * words. The folder is written by agents: nothing is followed through a link, a bundle whose program
 * is a link or is not a binary is not a build, and the walk stops at a cap however large the folder.
 */
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NativeArch, type NativeHost, NativePlatform } from "../../shared/play-native.ts";
import { linuxBuildOf } from "../../shared/publish-platforms.ts";
import { diskBytes } from "../../substrate/storage-folders.ts";

/** How deep under the game folder builds are looked for, and how many entries one look reads. */
const WALK_DEPTH_MAX = 6;
const WALK_ENTRIES_MAX = 20_000;
/** Folders no build is in: an engine's caches, packages and the version history. */
const SKIPPED = new Set([
  ".git",
  "node_modules",
  "Library",
  "Temp",
  "Logs",
  "obj",
  ".godot",
  ".import",
  ".studio",
  "Intermediate",
  "DerivedDataCache",
  "Saved",
]);
/**
 * An Unreal project's own build output, beside its `.uproject`: UnrealBuildTool's programs there
 * have no cooked content and never run as the game (a package keeps its `Binaries` under `<Game>/`).
 */
const UNREAL_PROJECT_BINARIES = "Binaries";
const UNREAL_PROJECT = /\.uproject$/i;
/** Programs an engine ships beside a game's own (Unreal's prerequisites installer among them): never the game. */
const HELPER_EXE = /^(UnityCrashHandler|CrashReportClient|unins|setup|UEPrereqSetup)/i;
/** The name Unity and Godot give a Linux player: `<Game>.x86_64`, `<Game>.arm64`. */
const LINUX_PLAYER = /\.(x86_64|arm64|aarch64)$/i;
/** The folders an Unreal package keeps a Linux game's program in, under `<Game>/Binaries/`. */
const UNREAL_LINUX_BINARIES = new Set(["Linux", "LinuxArm64"]);
/** Unreal's own folder in a package: its programs are the engine's, never the game. */
const UNREAL_ENGINE = "Engine";

/**
 * A thin Mach-O header by its first four bytes read big-endian: its whole size (`mach_header_64`,
 * `mach_header`) and whether its fields are little-endian, as arm64 and x86_64 programs write them.
 */
const THIN_MACH_O: ReadonlyMap<number, { bytes: number; little: boolean }> = new Map([
  [0xcffaedfe, { bytes: 32, little: true }],
  [0xfeedfacf, { bytes: 32, little: false }],
  [0xcefaedfe, { bytes: 28, little: true }],
  [0xfeedface, { bytes: 28, little: false }],
]);
/** A fat Mach-O header's magic and the size of each entry it lists (`fat_arch`, `fat_arch_64`); its fields are big-endian. */
const FAT_ENTRY_BYTES: ReadonlyMap<number, number> = new Map([
  [0xcafebabe, 20],
  [0xcafebabf, 32],
]);
/** A fat header's magic and entry count, before its entries. */
const FAT_HEADER_BYTES = 8;
/** The most processors one fat program lists: more is another file that starts the same way (a Java class). */
const FAT_ENTRIES_MAX = 16;
/** How much of a program its Mach-O header is read from: the largest fat header fits. */
const MACH_O_HEAD_BYTES = 4096;
/** The PE machine field's values Genex knows. */
const PE_MACHINE: Readonly<Record<number, typeof NativeArch.X64 | typeof NativeArch.Arm64>> = {
  0x8664: NativeArch.X64,
  0xaa64: NativeArch.Arm64,
};
/** An ELF file's first four bytes, read big-endian, and the header fields Genex reads. */
const ELF_MAGIC = 0x7f454c46;
const ELF_CLASS_64 = 2;
const ELF_LITTLE_ENDIAN = 1;
/** ELF `e_type`: a program, linked fixed or position-independent (a shared library is that too, so names decide). */
const ELF_PROGRAM_TYPES = new Set([2, 3]);
/** The ELF machine field's values Genex knows. */
const ELF_MACHINE: Readonly<Record<number, typeof NativeArch.X64 | typeof NativeArch.Arm64>> = {
  0x3e: NativeArch.X64,
  0xb7: NativeArch.Arm64,
};
/** Mach-O CPU types in a fat header or a thin one, and the processor each is (arm64e and x86_64h among them). */
const MACH_O_CPU: Readonly<Record<number, NativeHost["arch"]>> = {
  0x0100000c: NativeArch.Arm64,
  0x01000007: NativeArch.X64,
};
/** The processors a Mac program may carry, in the order they are answered. */
const MAC_PROCESSORS: readonly NativeHost["arch"][] = [NativeArch.Arm64, NativeArch.X64];

/** A player build found in a game folder. */
export interface FoundBuild {
  platform: NativePlatform;
  /** Its processors; a Mac app with both is universal. */
  arch: NativeArch;
  /** The `.app`, the `.exe` or the Linux program, relative to the game folder. */
  entry: string;
  /** What is shipped, relative to the game folder: the bundle, or the folder the program and its data are in. */
  folder: string;
  /** The space the build takes (the bundle, or the program's folder). */
  bytes: number;
  /** When its program was last written, ms since the epoch. */
  builtAt: number;
}

/** The first `length` bytes of a file, or none when it cannot be read as one. */
async function head(file: string, length: number): Promise<Buffer | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The CPU types a Mach-O header lists, or null when `bytes` do not start with a whole one. */
function machOCpus(bytes: Buffer): number[] | null {
  if (bytes.length < FAT_HEADER_BYTES) return null;
  const magic = bytes.readUInt32BE(0);
  const thin = THIN_MACH_O.get(magic);
  if (thin) {
    if (bytes.length < thin.bytes) return null;
    return [thin.little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4)];
  }
  const entry = FAT_ENTRY_BYTES.get(magic);
  if (entry === undefined) return null;
  const count = bytes.readUInt32BE(4);
  const listed = count > 0 && count <= FAT_ENTRIES_MAX && FAT_HEADER_BYTES + count * entry <= bytes.length;
  if (!listed) return null;
  return Array.from({ length: count }, (_, at) => bytes.readUInt32BE(FAT_HEADER_BYTES + at * entry));
}

/**
 * The processors a Mac program carries, read from its Mach-O header (thin or fat) in this process:
 * `lipo` needs Apple's developer tools, which most Macs don't have. Empty for a Mach-O program for
 * no processor Genex knows; null for a file that does not start with a whole Mach-O header.
 */
export async function machOProcessors(file: string): Promise<NativeHost["arch"][] | null> {
  const bytes = await head(file, MACH_O_HEAD_BYTES);
  const cpus = bytes ? machOCpus(bytes) : null;
  if (!cpus) return null;
  return MAC_PROCESSORS.filter((arch) => cpus.some((cpu) => MACH_O_CPU[cpu] === arch));
}

/** The processors a Mach-O program carries, read from its header; null when it is not one or carries none Genex knows. */
export async function machOArch(file: string): Promise<NativeArch | null> {
  const processors = await machOProcessors(file);
  if (processors?.length === MAC_PROCESSORS.length) return NativeArch.Universal;
  return processors?.[0] ?? null;
}

/** The processor a PE program is for, read from its header; null when it is not one Genex knows. */
export async function peArch(file: string): Promise<NativeArch | null> {
  const bytes = await head(file, 1024);
  if (!bytes || bytes.length < 64 || bytes.toString("latin1", 0, 2) !== "MZ") return null;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 6 > bytes.length || bytes.toString("latin1", pe, pe + 4) !== "PE\0\0") return null;
  return PE_MACHINE[bytes.readUInt16LE(pe + 4)] ?? null;
}

/** The processor a 64-bit little-endian ELF program is for, read from its header; null when it is not one Genex knows. */
export async function elfArch(file: string): Promise<NativeArch | null> {
  const bytes = await head(file, 64);
  if (!bytes || bytes.length < 20 || bytes.readUInt32BE(0) !== ELF_MAGIC) return null;
  if (bytes[4] !== ELF_CLASS_64 || bytes[5] !== ELF_LITTLE_ENDIAN) return null;
  if (!ELF_PROGRAM_TYPES.has(bytes.readUInt16LE(16))) return null;
  return ELF_MACHINE[bytes.readUInt16LE(18)] ?? null;
}

/** The longest Info.plist read. */
const PLIST_MAX_BYTES = 64 * 1024;

/**
 * The program a Mac bundle runs: its Info.plist's CFBundleExecutable (an XML plist), else, for a
 * binary plist, the one file in `Contents/MacOS`; null when neither names one.
 */
async function bundleProgram(app: string): Promise<string | null> {
  const plist = await head(path.join(app, "Contents", "Info.plist"), PLIST_MAX_BYTES);
  if (!plist) return null;
  const text = plist.toString("utf8");
  const named = /<key>CFBundleExecutable<\/key>\s*<string>([^<]{1,255})<\/string>/.exec(text)?.[1];
  const files = named ? [named] : await readdir(path.join(app, "Contents", "MacOS")).catch(() => []);
  const name = files.length === 1 ? files[0] : undefined;
  if (!name || name.includes("/") || name === ".." || name === ".") return null;
  return path.join(app, "Contents", "MacOS", name);
}

/** Whether `file`, every link on the way followed, is still inside `dir`. */
async function insideOf(dir: string, file: string): Promise<boolean> {
  const [base, target] = await Promise.all([realpath(dir).catch(() => null), realpath(file).catch(() => null)]);
  return base !== null && target !== null && target.startsWith(base + path.sep);
}

/** A `.app` folder as a build, or null: its program must be a plain file and a Mach-O one. */
async function macBuild(root: string, app: string): Promise<FoundBuild | null> {
  const program = await bundleProgram(app);
  if (!program) return null;
  const info = await stat(program).catch(() => null);
  const real = await lstat(program).catch(() => null);
  if (!info?.isFile() || !real?.isFile()) return null;
  // A link on the way (Contents or MacOS) must not lead the program out of the bundle.
  if (!(await insideOf(app, program))) return null;
  const arch = await machOArch(program);
  if (!arch) return null;
  const entry = path.relative(root, app).split(path.sep).join("/");
  return {
    platform: NativePlatform.Mac,
    arch,
    entry,
    folder: entry,
    bytes: await diskBytes(app),
    builtAt: info.mtimeMs,
  };
}

/** The game's own `.exe` among a folder's files, as a build, or null. */
async function windowsBuild(root: string, dir: string, names: readonly string[]): Promise<FoundBuild | null> {
  const candidates = names.filter((name) => name.toLowerCase().endsWith(".exe") && !HELPER_EXE.test(name));
  for (const name of candidates) {
    const file = path.join(dir, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const arch = await peArch(file);
    if (!arch) continue;
    const entry = path.relative(root, file).split(path.sep).join("/");
    const folder = path.relative(root, dir).split(path.sep).join("/");
    return {
      platform: NativePlatform.Windows,
      arch,
      entry,
      folder,
      bytes: await diskBytes(dir),
      builtAt: info.mtimeMs,
    };
  }
  return null;
}

/** Whether `dir` is an Unreal package's `<Game>/Binaries/Linux`, where its Linux program is. */
function isUnrealLinuxBinaries(dir: string): boolean {
  const parts = dir.split(path.sep);
  return UNREAL_LINUX_BINARIES.has(parts.at(-1) ?? "") && parts.at(-2) === "Binaries" && parts.at(-3) !== UNREAL_ENGINE;
}

/**
 * The names among a folder's files that may be a Linux game's program: `<Game>.x86_64` anywhere, and
 * in an Unreal package's binaries folder a name with no extension (beside it lie `.so`, `.debug`
 * and `.sym` files, ELF too, and never the game).
 */
function linuxCandidates(dir: string, names: readonly string[]): string[] {
  const unreal = isUnrealLinuxBinaries(dir);
  return names.filter((name) => !HELPER_EXE.test(name) && (LINUX_PLAYER.test(name) || (unreal && !name.includes("."))));
}

/** The game's own Linux program among a folder's files, as a build, or null. */
async function linuxBuild(root: string, dir: string, names: readonly string[]): Promise<FoundBuild | null> {
  for (const name of linuxCandidates(dir, names)) {
    const file = path.join(dir, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const arch = await elfArch(file);
    if (!arch) continue;
    const entry = path.relative(root, file).split(path.sep).join("/");
    const build = linuxBuildOf(entry);
    if (!build) continue;
    const bytes = await diskBytes(path.join(root, ...build.folder.split("/")));
    return { platform: NativePlatform.Linux, arch, entry, folder: build.folder, bytes, builtAt: info.mtimeMs };
  }
  return null;
}

/**
 * The player builds under `root`, newest first: every `.app` that is a Mac app, every folder whose
 * `.exe` is a Windows program and every folder whose Linux program is a game's. Links are never followed, engine caches are skipped, and the look
 * stops after {@link WALK_ENTRIES_MAX} entries.
 */
export async function findNativeBuilds(root: string): Promise<FoundBuild[]> {
  const found: FoundBuild[] = [];
  let seen = 0;
  const pending: Folder[] = [{ dir: root, depth: 0 }];
  for (let next = pending.shift(); next && seen < WALK_ENTRIES_MAX; next = pending.shift()) {
    const entries = await readdir(next.dir, { withFileTypes: true }).catch(() => []);
    seen += entries.length;
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const windows = await windowsBuild(root, next.dir, files);
    if (windows) found.push(windows);
    const linux = await linuxBuild(root, next.dir, files);
    if (linux) found.push(linux);
    // A Windows build's folder ships whole: the programs inside it (an Unreal package's game and
    // engine binaries under its starter) are its own, never builds of their own.
    if (windows && next.depth > 0) continue;
    const project = files.some((name) => UNREAL_PROJECT.test(name));
    const folders = entries.filter(
      (entry) =>
        entry.isDirectory() && !SKIPPED.has(entry.name) && !(project && entry.name === UNREAL_PROJECT_BINARIES),
    );
    for (const entry of folders) await lookIn(root, next, entry.name, found, pending);
  }
  return found.sort((a, b) => b.builtAt - a.builtAt);
}

/** A folder still to look in, and how deep under the game folder it is. */
interface Folder {
  dir: string;
  depth: number;
}

/** One folder of `parent`: a `.app` is read as a build, any other is looked in later while not too deep. */
async function lookIn(
  root: string,
  parent: Folder,
  name: string,
  found: FoundBuild[],
  pending: Folder[],
): Promise<void> {
  const dir = path.join(parent.dir, name);
  if (!name.toLowerCase().endsWith(".app")) {
    if (parent.depth < WALK_DEPTH_MAX) pending.push({ dir, depth: parent.depth + 1 });
    return;
  }
  const mac = await macBuild(root, dir);
  if (mac) found.push(mac);
}
