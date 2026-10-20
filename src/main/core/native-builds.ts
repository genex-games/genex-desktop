/**
 * The player builds a game folder holds: a Mac app (a `.app` with an Info.plist and a Mach-O program
 * inside) and a Windows program (a PE `.exe` beside its data), wherever Unity, Godot or Unreal put
 * them. Platform and processor are read from the binary itself, never from a name or the author's
 * words. The folder is written by agents: nothing is followed through a link, a bundle whose program
 * is a link or is not a binary is not a build, and the walk stops at a cap however large the folder.
 */
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NativeArch, NativePlatform } from "../../shared/play-native.ts";
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
/** Programs an engine ships beside a game's own: never the game. */
const HELPER_EXE = /^(UnityCrashHandler|CrashReportClient|unins|setup)/i;

/** Mach-O magic numbers, as the first four bytes read big-endian: thin 64-bit either way round, and fat. */
const MACH_O = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
/** The PE machine field's values Genex knows. */
const PE_MACHINE: Readonly<Record<number, typeof NativeArch.X64 | typeof NativeArch.Arm64>> = {
  0x8664: NativeArch.X64,
  0xaa64: NativeArch.Arm64,
};
/** Mach-O CPU types in a fat header or a thin one. */
const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

/** A player build found in a game folder. */
export interface FoundBuild {
  platform: NativePlatform;
  /** Its processors; a Mac app with both is universal. */
  arch: NativeArch;
  /** The `.app` or the `.exe`, relative to the game folder. */
  entry: string;
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

/** The processors a Mach-O program carries, read from its header; null when it is not one. */
export async function machOArch(file: string): Promise<NativeArch | null> {
  const bytes = await head(file, 4096);
  if (!bytes || bytes.length < 8 || !MACH_O.has(bytes.readUInt32BE(0))) return null;
  const magic = bytes.readUInt32BE(0);
  const cpus: number[] = [];
  if (magic === 0xcafebabe) {
    const count = Math.min(bytes.readUInt32BE(4), 16);
    for (let at = 0; at < count && 8 + at * 20 + 4 <= bytes.length; at++) cpus.push(bytes.readUInt32BE(8 + at * 20));
  } else cpus.push(magic === 0xfeedfacf ? bytes.readUInt32BE(4) : bytes.readUInt32LE(4));
  const arm = cpus.includes(CPU_ARM64);
  const intel = cpus.includes(CPU_X86_64);
  if (arm && intel) return NativeArch.Universal;
  if (arm) return NativeArch.Arm64;
  return intel ? NativeArch.X64 : null;
}

/** The processor a PE program is for, read from its header; null when it is not one Genex knows. */
export async function peArch(file: string): Promise<NativeArch | null> {
  const bytes = await head(file, 1024);
  if (!bytes || bytes.length < 64 || bytes.toString("latin1", 0, 2) !== "MZ") return null;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 6 > bytes.length || bytes.toString("latin1", pe, pe + 4) !== "PE\0\0") return null;
  return PE_MACHINE[bytes.readUInt16LE(pe + 4)] ?? null;
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
  return { platform: NativePlatform.Mac, arch, entry, bytes: await diskBytes(app), builtAt: info.mtimeMs };
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
    return { platform: NativePlatform.Windows, arch, entry, bytes: await diskBytes(dir), builtAt: info.mtimeMs };
  }
  return null;
}

/**
 * The player builds under `root`, newest first: every `.app` that is a Mac app and every folder whose
 * `.exe` is a Windows program. Links are never followed, engine caches are skipped, and the look
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
    const folders = entries.filter((entry) => entry.isDirectory() && !SKIPPED.has(entry.name));
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
