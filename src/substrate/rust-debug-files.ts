/**
 * The debug files a Rust export keeps beside its shipped output, never in it (CRASH-7a), so a
 * crash record's raw addresses can be symbolicated on the host later (CRASH-7b):
 *
 * - **Apple** (Mac, iOS): cargo's release profile with line tables, `split-debuginfo="packed"`
 *   (rustc runs `dsymutil`, so a `<exe>.dSYM` sits beside the executable) and
 *   `strip="debuginfo"`, which takes the debug map (`N_OSO` entries naming the build folder's
 *   object files) out of the shipped executable after the dSYM is made. Measured on the pinned
 *   1.99 toolchain: the shipped executable is exactly as long as one built without line tables,
 *   and its `LC_UUID` matches the dSYM's.
 * - **ELF and PE** (Linux, Android, Windows): line tables in the executable itself
 *   (`split-debuginfo="off"`, `strip="none"`). Split DWARF would leave the line program in the
 *   executable's skeleton units, so a stripped executable plus a `.dwp` loses lines, and the
 *   store's toolchain carries no `llvm-dwp`. The unstripped executable is kept; the shipped one
 *   is a copy the toolchain's `llvm-objcopy --strip-debug` wrote (run in the build's sandbox).
 *   A toolchain without `llvm-objcopy` builds the export as before and keeps nothing.
 * - **Web**: no cargo setting. `wasm-opt -Oz` drops the name section from the module it writes
 *   but keeps any DWARF it is given (measured on binaryen version_133), so line tables would ship.
 *   The export's `wasm-opt --symbolmap` writes the function-index-to-name map
 *   ({@link WEB_SYMBOL_MAP_FILE}) outside the served folder instead.
 *
 * The files go to `<bin>.debug/<digest>/` (beside `<bin>.out`, outside every build-writable path),
 * where `<digest>` is the SHA-256 of the shipped executable or module, the same digest a run's
 * `BuildIdentity` carries, with a {@link DEBUG_INDEX_FILE} naming them. At most
 * {@link DEBUG_BUILDS_KEPT} builds are kept per build folder (game, destination and lock); the
 * oldest goes first. The lane's sweep removes `<bin>.debug` with its build folder.
 */
import { constants as FS_CONSTANTS } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, readRegularFile } from "./fsx.ts";
import { isInside } from "./paths.ts";
import { shellQuote } from "./shell-quote.ts";

/** How a destination's export keeps its debug files. Wire values: the index names them. */
export const DebugFileKind = {
  /** A `<exe>.dSYM` bundle beside the executable (Apple). */
  Dsym: "dsym",
  /** The executable before `llvm-objcopy --strip-debug` (ELF and PE). */
  Unstripped: "unstripped",
  /** wasm-opt's function-index-to-name map (web). */
  SymbolMap: "symbol-map",
} as const;
export type DebugFileKind = (typeof DebugFileKind)[keyof typeof DebugFileKind];

/** How many builds' debug files one build folder keeps; the oldest is pruned first. */
export const DEBUG_BUILDS_KEPT = 4;
/** The index each kept build's folder carries. */
export const DEBUG_INDEX_FILE = "debug.json";
/** The name a web export's symbol map is kept under. */
export const WEB_SYMBOL_MAP_FILE = "game_bg.symbols";
/** The index's format. */
const DEBUG_INDEX_VERSION = 1;
/** Beside the build folder `<bin>`: the kept builds' folders. */
const DEBUG_SUFFIX = ".debug";
/** A folder being written, renamed into place once whole. */
const FRESH_SUFFIX = ".new";
/** The biggest index read back. */
const INDEX_MAX_BYTES = 256 * 1024;
/** A build digest: the shipped file's SHA-256, lower-case hex. */
const BUILD_DIGEST = /^[0-9a-f]{64}$/;
/** A kept file's name: one plain path segment. */
const KEPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LINE_TABLES = 'profile.release.debug="line-tables-only"';

/** The release-profile settings, as cargo `--config` values, an export of each kind builds with. */
export const EXPORT_DEBUG_SETTINGS = {
  [DebugFileKind.Dsym]: [LINE_TABLES, 'profile.release.split-debuginfo="packed"', 'profile.release.strip="debuginfo"'],
  [DebugFileKind.Unstripped]: [LINE_TABLES, 'profile.release.split-debuginfo="off"', 'profile.release.strip="none"'],
  [DebugFileKind.SymbolMap]: [],
} as const satisfies Record<DebugFileKind, readonly string[]>;

/** How an export for rustc's `triple` keeps its debug files. */
export function debugFileKind(triple: string): DebugFileKind {
  if (triple.startsWith("wasm32-")) return DebugFileKind.SymbolMap;
  if (triple.includes("-apple-")) return DebugFileKind.Dsym;
  return DebugFileKind.Unstripped;
}

/** The toolchain's `llvm-objcopy` (the `llvm-tools` part) for the compiler's `host` triple, beside the sysroot's `bin`. */
export function rustObjcopy(toolchainBin: string, host: string): string {
  return path.join(toolchainBin, "..", "lib", "rustlib", host, "bin", "llvm-objcopy");
}

/** `llvm-objcopy --strip-debug <from> <to>`, every word quoted. */
export function stripDebugCommand(objcopy: string, from: string, to: string): string {
  return [objcopy, "--strip-debug", from, to].map(shellQuote).join(" ");
}

/** Where the kept builds' folders of build folder `bin` live. */
export function debugRootOf(bin: string): string {
  return `${bin}${DEBUG_SUFFIX}`;
}

/** One file or folder to keep: where the build left it and the plain name it is kept under. */
export interface DebugSource {
  from: string;
  as: string;
}

/** What {@link keepDebugFiles} keeps. */
export interface KeepDebugInput {
  /** The build folder: the files go to `<bin>.debug/<digest>/`. */
  bin: string;
  /** The shipped executable's or module's SHA-256. */
  digest: string;
  target: string;
  triple: string;
  kind: DebugFileKind;
  sources: readonly DebugSource[];
  /** Every source, its links resolved, must be under this folder (the build folder); one elsewhere is left out. */
  within: string;
  now: () => number;
}

/** A kept build's index. */
export interface DebugIndex {
  version: typeof DEBUG_INDEX_VERSION;
  digest: string;
  target: string;
  triple: string;
  kind: DebugFileKind;
  keptAt: string;
  /** Every regular file kept, `/`-separated under the build's folder, with its size. */
  files: { path: string; bytes: number }[];
}

/**
 * Keeps `sources` in `<bin>.debug/<digest>/` with its index, replacing that build's earlier
 * folder, then prunes the root to {@link DEBUG_BUILDS_KEPT}. Only regular files and folders are
 * copied, never through a link inside a source; a source that is a link is followed only to a
 * place under `within`. Answers the index, or null when the digest is not one or nothing was
 * kept (nothing written then).
 */
export async function keepDebugFiles(input: KeepDebugInput): Promise<DebugIndex | null> {
  if (!BUILD_DIGEST.test(input.digest)) return null;
  const resolved = await resolveSources(input.sources, input.within);
  if (resolved.length === 0) return null;
  const root = debugRootOf(input.bin);
  await ownFolder(root);
  const folder = path.join(root, input.digest);
  const fresh = `${folder}${FRESH_SUFFIX}`;
  await rm(fresh, { recursive: true, force: true });
  await mkdir(fresh);
  const files: DebugIndex["files"] = [];
  for (const source of resolved) files.push(...(await copyKept(source.real, fresh, source.as)));
  const index: DebugIndex = {
    version: DEBUG_INDEX_VERSION,
    digest: input.digest,
    target: input.target,
    triple: input.triple,
    kind: input.kind,
    keptAt: new Date(input.now()).toISOString(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  await atomicWriteText(path.join(fresh, DEBUG_INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
  await rm(folder, { recursive: true, force: true });
  await rename(fresh, folder);
  await pruneDebugBuilds(root);
  return index;
}

/**
 * The kept folder of the build whose shipped file has `digest`, with its index, when it is a real
 * folder whose index names that digest; null otherwise (the symbolication step's lookup).
 */
export async function keptDebugBuild(
  bin: string,
  digest: string,
): Promise<{ folder: string; index: DebugIndex } | null> {
  if (!BUILD_DIGEST.test(digest)) return null;
  const root = debugRootOf(bin);
  if (!(await lstat(root).catch(() => null))?.isDirectory()) return null;
  const folder = path.join(root, digest);
  const index = await readIndex(folder);
  return index?.digest === digest ? { folder, index } : null;
}

/**
 * Removes every kept build past the newest `kept` (by the index's `keptAt`), every digest folder
 * with no readable index first, and any half-written folder. Answers the digests removed.
 */
export async function pruneDebugBuilds(root: string, kept = DEBUG_BUILDS_KEPT): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const builds: { digest: string; at: number }[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith(FRESH_SUFFIX)) {
      await rm(path.join(root, entry.name), { recursive: true, force: true });
      continue;
    }
    if (!BUILD_DIGEST.test(entry.name)) continue;
    const index = entry.isDirectory() ? await readIndex(path.join(root, entry.name)) : null;
    const at = index ? Date.parse(index.keptAt) : Number.NEGATIVE_INFINITY;
    builds.push({ digest: entry.name, at: Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at });
  }
  builds.sort((a, b) => b.at - a.at || a.digest.localeCompare(b.digest));
  const removed = builds.slice(kept).map((build) => build.digest);
  for (const digest of removed) await rm(path.join(root, digest), { recursive: true, force: true });
  return removed;
}

/** The sources that resolve to a regular file or folder under `within`, with a plain name. */
async function resolveSources(
  sources: readonly DebugSource[],
  within: string,
): Promise<{ real: string; as: string }[]> {
  const root = await realpath(within).catch(() => null);
  if (root === null) return [];
  const resolved: { real: string; as: string }[] = [];
  for (const source of sources) {
    if (!KEPT_NAME.test(source.as)) continue;
    const real = await realpath(source.from).catch(() => null);
    if (real === null || !isInside(root, real)) continue;
    const found = await lstat(real).catch(() => null);
    if (found?.isFile() || found?.isDirectory()) resolved.push({ real, as: source.as });
  }
  return resolved;
}

/** Copies the regular file or folder tree at `from` to `<to>/<name>`, links left out. Answers what it copied. */
async function copyKept(from: string, to: string, name: string): Promise<DebugIndex["files"]> {
  const found = await lstat(from);
  const into = path.join(to, name);
  if (found.isFile()) {
    // A clone where the file system makes one (APFS): a file of its own, without copying the bytes.
    await copyFile(from, into, FS_CONSTANTS.COPYFILE_FICLONE);
    return [{ path: name, bytes: found.size }];
  }
  await mkdir(into);
  const files: DebugIndex["files"] = [];
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const copied = await copyKept(path.join(from, entry.name), into, entry.name);
    files.push(...copied.map((file) => ({ ...file, path: `${name}/${file.path}` })));
  }
  return files;
}

/** A kept build's index when it reads as one; null otherwise. */
async function readIndex(folder: string): Promise<DebugIndex | null> {
  const bytes = await readRegularFile(path.join(folder, DEBUG_INDEX_FILE), INDEX_MAX_BYTES).catch(() => null);
  if (!bytes) return null;
  try {
    const index = JSON.parse(bytes.toString("utf8")) as Partial<DebugIndex>;
    const valid = index.version === DEBUG_INDEX_VERSION && typeof index.digest === "string";
    return valid && typeof index.keptAt === "string" && Array.isArray(index.files) ? (index as DebugIndex) : null;
  } catch {
    return null;
  }
}

/** `dir` as a real folder: a link or a file at its name is removed first (the link itself, never what it names). */
async function ownFolder(dir: string): Promise<void> {
  const found = await lstat(dir).catch(() => null);
  if (found?.isDirectory()) return;
  if (found) await rm(dir, { recursive: true, force: true });
  await mkdir(dir);
}
