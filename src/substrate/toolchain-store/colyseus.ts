/**
 * The relay client's native core in the store (MP-1a): Colyseus native-sdk's pinned prebuilt
 * assets (`COLYSEUS_ASSETS`) laid out as one folder of static libraries per native triple,
 * `lib/<triple>/lib<name>.a`, the folder the vendored crate's build script reads from
 * `GENEX_COLYSEUS_LIB_DIR` (`main/rust-colyseus.ts`). The xcframework gives the Mac, iPhone and
 * Simulator slices, the Linux tarball and the MinGW zip their `lib/` folders; the zip's
 * `<name>.lib` files are renamed `lib<name>.a`, the name a GNU-style link looks for.
 *
 * Every asset is checked before anything is written: its size and sha256 against the pin, then
 * every entry (no link of any kind, nothing larger than {@link COLYSEUS_ENTRY_BYTES_MAX}, the
 * whole no larger than {@link COLYSEUS_UNPACKED_BYTES_MAX}); the store's own extractor refuses a
 * name that is absolute or climbs. The arrangement then reads each library without following a
 * link, thins Apple's universal libraries to their arm64 slice and refuses one that is not an `ar` archive. A refused asset leaves the destination as it
 * was: everything is staged beside it and swapped in only whole.
 */
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  ArchiveFormat,
  COLYSEUS_ASSETS,
  COLYSEUS_LIBRARIES,
  COLYSEUS_TRIPLES,
  ColyseusAsset,
  ColyseusTriple,
  ToolchainError,
  type ToolchainEntry,
  ToolchainProblem,
} from "../../shared/toolchain.ts";
import { openNoFollow } from "../fsx.ts";
import { type ArchiveEntry, ArchiveEntryType, extractArchive, listArchive } from "./archive.ts";

/** The largest one entry of a prebuilt asset may be: the biggest upstream library (the universal macOS one) is 27 MB. */
export const COLYSEUS_ENTRY_BYTES_MAX = 64 * 1024 * 1024;
/** The most one asset may unpack to: the xcframework, the largest, unpacks to 84 MB. */
export const COLYSEUS_UNPACKED_BYTES_MAX = 256 * 1024 * 1024;
/** The folder of a staged `colyseus` component that holds the per-triple library folders. */
export const COLYSEUS_LIB_FOLDER = "lib";
/** What a static library starts with: the `ar` global header. */
const AR_MAGIC = Buffer.from("!<arch>\n", "latin1");
/** Apple's universal (fat) header, 32-bit offsets: the xcframework's macOS and Simulator slices wrap an `ar` per architecture. */
const FAT_MAGIC = 0xcafebabe;
/** The fat header's size, and each architecture record's (cputype, cpusubtype, offset, size, align). */
const FAT_HEADER_BYTES = 8;
const FAT_ARCH_BYTES = 20;
/** `CPU_TYPE_ARM64`: every Apple triple Genex builds is arm64, so a universal library is thinned to that slice. */
const CPU_TYPE_ARM64 = 0x0100000c;

const MESSAGE = {
  Size: (asset: string, bytes: number) => `${asset} is ${bytes} bytes, not the pinned size.`,
  Digest: (asset: string, sha256: string) => `${asset} has sha256 ${sha256}, not the pinned one.`,
  Link: (name: string) => `${name} is a link; a libcolyseus asset holds only files and folders.`,
  Entry: (name: string, bytes: number) =>
    `${name} is ${bytes} bytes; no libcolyseus file is larger than ${COLYSEUS_ENTRY_BYTES_MAX}.`,
  Total: (bytes: number) => `The asset unpacks to ${bytes} bytes; the limit is ${COLYSEUS_UNPACKED_BYTES_MAX}.`,
  NoSlice: (triple: string, file: string) => `The asset has no ${file} for ${triple}.`,
  NotFolder: (rel: string) => `${rel} is a link or not a folder.`,
  NotLibrary: (rel: string) => `${rel} is not a static library.`,
  Source: (asset: string) => `${asset} is built, never laid out as a prebuilt.`,
} as const;

const refuse = (problem: ToolchainProblem, message: string) => new ToolchainError(problem, message);

/** The archive format of a prebuilt asset, by its file name. */
function formatOf(asset: ColyseusAsset): ArchiveFormat {
  return asset.endsWith(".zip") ? ArchiveFormat.Zip : ArchiveFormat.TarGz;
}

/** The prebuilt triples `asset` serves, in table order (none for the source tarball). */
export function triplesOf(asset: ColyseusAsset): ColyseusTriple[] {
  if (asset === ColyseusAsset.Source) return [];
  return Object.values(ColyseusTriple).filter((triple) => COLYSEUS_TRIPLES[triple].asset === asset);
}

/** The file name upstream gives `library` in an asset whose libraries end in `suffix`. */
function upstreamName(library: string, suffix: string): string {
  return suffix === ".lib" ? `${library}.lib` : `lib${library}.a`;
}

/** The file of `library` in a per-triple folder: what the build script and the linker look for. */
export function colyseusLibraryFile(library: string): string {
  return `lib${library}.a`;
}

/** Refuses (`integrity`) a downloaded asset whose size or sha256 is not its pin. */
export async function verifyColyseusAsset(file: string, asset: ColyseusAsset): Promise<void> {
  const pin = COLYSEUS_ASSETS[asset];
  const info = await lstat(file);
  if (!info.isFile() || info.size !== pin.bytes)
    throw refuse(ToolchainProblem.Integrity, MESSAGE.Size(asset, info.size));
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  const sha256 = hash.digest("hex");
  if (sha256 !== pin.sha256) throw refuse(ToolchainProblem.Integrity, MESSAGE.Digest(asset, sha256));
}

/** Refuses (`archive`) an entry list with a link, an oversized entry or too much in all, before anything is written. */
export function checkColyseusEntries(entries: readonly ArchiveEntry[]): void {
  let total = 0;
  for (const entry of entries) {
    const linked = entry.type === ArchiveEntryType.Symlink || entry.type === ArchiveEntryType.Hardlink;
    if (linked) throw refuse(ToolchainProblem.Archive, MESSAGE.Link(entry.name));
    if (entry.size > COLYSEUS_ENTRY_BYTES_MAX)
      throw refuse(ToolchainProblem.Archive, MESSAGE.Entry(entry.name, entry.size));
    total += entry.size;
  }
  if (total > COLYSEUS_UNPACKED_BYTES_MAX) throw refuse(ToolchainProblem.Archive, MESSAGE.Total(total));
}

/** `root/rel`, after checking that no folder on the way (`rel`'s segments) is a link or anything but a folder. */
async function realFolderPath(root: string, rel: string): Promise<string> {
  let at = root;
  for (const segment of rel.split("/").filter(Boolean)) {
    at = path.join(at, segment);
    const info = await lstat(at).catch(() => null);
    if (!info?.isDirectory()) throw refuse(ToolchainProblem.Archive, MESSAGE.NotFolder(path.relative(root, at)));
  }
  return at;
}

/**
 * `bytes`, or its arm64 slice when it is a universal (fat) library: rustc reads no fat archive
 * ("Unsupported archive identifier" for the Simulator). Null when a fat header names no arm64
 * slice or one outside the file.
 */
export function thinToArm64(bytes: Buffer): Buffer | null {
  if (bytes.length < FAT_HEADER_BYTES || bytes.readUInt32BE(0) !== FAT_MAGIC) return bytes;
  const count = bytes.readUInt32BE(4);
  for (let index = 0; index < count; index++) {
    const at = FAT_HEADER_BYTES + index * FAT_ARCH_BYTES;
    if (at + FAT_ARCH_BYTES > bytes.length) return null;
    if (bytes.readUInt32BE(at) !== CPU_TYPE_ARM64) continue;
    const offset = bytes.readUInt32BE(at + 8);
    const size = bytes.readUInt32BE(at + 12);
    return offset + size <= bytes.length ? bytes.subarray(offset, offset + size) : null;
  }
  return null;
}

/**
 * Copies `source` to `target` without following a link: refused (`archive`) when it is not a
 * regular file, larger than {@link COLYSEUS_ENTRY_BYTES_MAX} or not an `ar` archive. Null when
 * `source` does not exist.
 */
async function copyLibrary(source: string, target: string, rel: string): Promise<true | null> {
  const present = await lstat(source).catch(() => null);
  if (present === null) return null;
  const handle = await openNoFollow(source, constants.O_RDONLY).catch(() => {
    throw refuse(ToolchainProblem.Archive, MESSAGE.Link(rel));
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw refuse(ToolchainProblem.Archive, MESSAGE.Link(rel));
    if (info.size > COLYSEUS_ENTRY_BYTES_MAX) throw refuse(ToolchainProblem.Archive, MESSAGE.Entry(rel, info.size));
    const bytes = thinToArm64(await handle.readFile());
    if (bytes === null || !bytes.subarray(0, AR_MAGIC.length).equals(AR_MAGIC))
      throw refuse(ToolchainProblem.Archive, MESSAGE.NotLibrary(rel));
    await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
    return true;
  } finally {
    await handle.close();
  }
}

/** Lays out one triple's libraries from `from` (its unpacked slice) into `to`; the core library is required. */
async function arrangeTriple(staging: string, triple: ColyseusTriple, to: string): Promise<void> {
  const slice = COLYSEUS_TRIPLES[triple];
  const into = COLYSEUS_ASSETS[slice.asset].into;
  const from = await realFolderPath(staging, `${into}/${slice.folder}`);
  await mkdir(to, { recursive: true });
  for (const library of COLYSEUS_LIBRARIES) {
    const name = upstreamName(library, slice.suffix);
    const copied = await copyLibrary(path.join(from, name), path.join(to, colyseusLibraryFile(library)), name);
    if (copied === null && library === COLYSEUS_LIBRARIES[0])
      throw refuse(ToolchainProblem.Archive, MESSAGE.NoSlice(triple, name));
  }
}

/**
 * Lays out `staging/lib/<triple>/` for every triple whose asset is unpacked in `staging` (each in
 * its `COLYSEUS_ASSETS` folder), then removes the unpacked assets. The install step for a
 * `colyseus` component. Answers the triples laid out.
 */
export async function arrangeColyseusLibs(staging: string): Promise<ColyseusTriple[]> {
  const prebuilt = [ColyseusAsset.Xcframework, ColyseusAsset.LinuxX64, ColyseusAsset.WindowsX64] as const;
  const unpacked: ColyseusAsset[] = [];
  for (const asset of prebuilt) {
    const into = await lstat(path.join(staging, COLYSEUS_ASSETS[asset].into)).catch(() => null);
    if (into !== null) unpacked.push(asset);
  }
  const triples = unpacked.flatMap(triplesOf);
  for (const triple of triples) await arrangeTriple(staging, triple, path.join(staging, COLYSEUS_LIB_FOLDER, triple));
  for (const asset of unpacked) await rm(path.join(staging, COLYSEUS_ASSETS[asset].into), { recursive: true });
  return triples;
}

/**
 * Installs one downloaded prebuilt asset into `dest/<triple>/` (the dev toolchain's
 * `tools/colyseus`): verified against its pin, then {@link installColyseusArchive}. A refusal
 * leaves `dest` as it was. Answers the triples installed.
 */
export async function installColyseusAsset(
  file: string,
  asset: ColyseusAsset,
  dest: string,
  options: { signal?: AbortSignal } = {},
): Promise<ColyseusTriple[]> {
  if (asset === ColyseusAsset.Source) throw refuse(ToolchainProblem.Archive, MESSAGE.Source(asset));
  await verifyColyseusAsset(file, asset);
  return installColyseusArchive(file, formatOf(asset), COLYSEUS_ASSETS[asset].into, dest, options);
}

/**
 * Lays out an asset archive (already verified) into `dest/<triple>/`: its entries checked
 * ({@link checkColyseusEntries}), extracted into `<into>` of a staging folder beside `dest`, laid
 * out ({@link arrangeColyseusLibs}), then each triple's folder swapped in whole. A refusal leaves
 * `dest` as it was and the staging folder removed.
 */
export async function installColyseusArchive(
  file: string,
  format: ArchiveFormat,
  into: string,
  dest: string,
  options: { signal?: AbortSignal } = {},
): Promise<ColyseusTriple[]> {
  checkColyseusEntries(await listArchive(file, format, options));
  await mkdir(path.dirname(dest), { recursive: true });
  const staging = await mkdtemp(`${dest}.staging-`);
  try {
    await extractArchive(file, format, staging, { strip: 0, into, signal: options.signal });
    const triples = await arrangeColyseusLibs(staging);
    await mkdir(dest, { recursive: true });
    for (const triple of triples) {
      const target = path.join(dest, triple);
      await rm(target, { recursive: true, force: true });
      await rename(path.join(staging, COLYSEUS_LIB_FOLDER, triple), target);
    }
    return triples;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const ASSETS: ReadonlySet<string> = new Set<string>(Object.values(ColyseusAsset));
const isColyseusAsset = (name: string): name is ColyseusAsset => ASSETS.has(name);

/** The prebuilt triples a `colyseus` manifest entry's archives serve, by each archive's asset name. */
export function colyseusEntryTriples(entry: Pick<ToolchainEntry, "archives">): ColyseusTriple[] {
  const assets = entry.archives.map((archive) => path.posix.basename(new URL(archive.url).pathname));
  return assets.filter(isColyseusAsset).flatMap(triplesOf);
}

/** The files that prove a `colyseus` component installed: each served triple's core library. */
export function colyseusProbeFiles(entry: Pick<ToolchainEntry, "archives">): string[] {
  return colyseusEntryTriples(entry).map(
    (triple) => `${COLYSEUS_LIB_FOLDER}/${triple}/${colyseusLibraryFile("colyseus")}`,
  );
}
