/**
 * Installing a Genex Library entry on demand: each file one delivery carries (`deliveryFiles`) is
 * taken from the plugin's storage when a copy there still matches its pin, else read from the pack
 * (the published release, or a local pack folder the build script wrote), its size and sha256
 * checked before anything is written, and written by rename so a half-written file is never read.
 * Then the delivery's files are staged in a fresh folder for `assets.deliver`. Names come from the
 * checked catalog (no slash, no dot segment), and a pack folder's file is read only when it is a
 * regular file, never through a link.
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deliveryFiles,
  type LibraryCatalog,
  type LibraryEntry,
  LibraryError,
  type LibraryPackFile,
  LibraryRefusal,
  type LibraryTier,
  libraryFolder,
  packFileName,
} from "../../shared/genex-library.ts";

/** The placeholder a published pack's base URL carries for the pack version an entry was built in. */
export const PACK_VERSION_PLACEHOLDER = "{pack}";

/** The hosts a published pack may be downloaded from: GitHub releases and their file servers. */
export const LIBRARY_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/** Where the pack's files come from. */
export type PackSource = { folder: string } | { baseUrl: string };

/** How the installer reaches the network; tests pass a stub. */
export interface LibraryNet {
  download(url: URL, maxBytes: number): Promise<Uint8Array>;
}

/** One installed delivery: the folder staged for `assets.deliver`, and what is in it. */
export interface StagedDelivery {
  entry: LibraryEntry;
  tier: LibraryTier | null;
  /** The game-relative folder the files land in (`assets/library/<folder>`). */
  folder: string;
  staged: string;
  files: LibraryPackFile[];
}

const MESSAGE = {
  Unpublished:
    "the Genex Library pack is not published yet: set the library plugin's pack folder (Settings, Plugins, Content Library) to a pack built by scripts/library/build-library.ts",
  Digest: (name: string) => `${name}: its sha256 is not the catalog's`,
  Size: (name: string, bytes: number, want: number) => `${name}: ${bytes} bytes, the catalog says ${want}`,
  NotFile: (name: string) => `${name}: not a regular file in the pack folder`,
  Host: (url: string) => `${url}: not https on a library host`,
} as const;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** `bytes` held to `file`'s pin: its size first, then its sha256. */
function checked(file: LibraryPackFile, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== file.bytes) {
    throw new LibraryError(LibraryRefusal.SizeMismatch, MESSAGE.Size(file.name, bytes.byteLength, file.bytes));
  }
  if (sha256(bytes) !== file.sha256) throw new LibraryError(LibraryRefusal.DigestMismatch, MESSAGE.Digest(file.name));
  return bytes;
}

/** The URL of a pack file under a published base: plain https on a library host. */
export function packUrl(baseUrl: string, pack: string, flatName: string): URL {
  const url = new URL(`${baseUrl.replaceAll(PACK_VERSION_PLACEHOLDER, pack)}/${flatName}`);
  const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
  if (!plain || !LIBRARY_HOSTS.has(url.hostname))
    throw new LibraryError(LibraryRefusal.DownloadFailed, MESSAGE.Host(url.href));
  return url;
}

/** A pack file's bytes from `source`, checked against its pin. */
async function fetchPackFile(
  source: PackSource,
  id: string,
  pack: string,
  file: LibraryPackFile,
  net: LibraryNet,
): Promise<Uint8Array> {
  const flat = packFileName(id, file.name);
  if ("baseUrl" in source) return checked(file, await net.download(packUrl(source.baseUrl, pack, flat), file.bytes));
  const at = path.join(source.folder, pack, flat);
  const stat = await lstat(at).catch(() => null);
  if (!stat?.isFile()) throw new LibraryError(LibraryRefusal.DownloadFailed, MESSAGE.NotFile(flat));
  if (stat.size !== file.bytes)
    throw new LibraryError(LibraryRefusal.SizeMismatch, MESSAGE.Size(flat, stat.size, file.bytes));
  return checked(file, new Uint8Array(await readFile(at)));
}

/** Whether the stored copy at `at` still matches `file`'s pin. */
async function storedMatches(at: string, file: LibraryPackFile): Promise<boolean> {
  const stat = await lstat(at).catch(() => null);
  if (!stat?.isFile() || stat.size !== file.bytes) return false;
  return sha256(new Uint8Array(await readFile(at))) === file.sha256;
}

/** The catalog's pack source: the person's local pack folder first, else the published release. */
export function packSource(catalog: LibraryCatalog, folder: string | undefined): PackSource {
  if (folder) return { folder: path.resolve(folder) };
  if (catalog.pack.baseUrl) return { baseUrl: catalog.pack.baseUrl };
  throw new LibraryError(LibraryRefusal.Unpublished, MESSAGE.Unpublished);
}

/** Each of `files` present in `<storage>/pack/<pack>/<folder>/`, fetched and checked when missing or changed. */
async function installFiles(
  storage: string,
  entry: LibraryEntry,
  files: readonly LibraryPackFile[],
  source: PackSource,
  net: LibraryNet,
): Promise<string> {
  const pack = entry.build?.pack ?? "";
  const dir = path.join(storage, "pack", pack, libraryFolder(entry.id));
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const at = path.join(dir, file.name);
    if (await storedMatches(at, file)) continue;
    const bytes = await fetchPackFile(source, entry.id, pack, file, net);
    const temporary = `${at}.${randomUUID()}.part`;
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, at);
  }
  return dir;
}

/**
 * Install entry `id` at `tier` (2k by default, `deliveryFiles`) into `storage` and stage its
 * delivery in a fresh folder of `<storage>/jobs/`; the caller delivers it and removes the folder.
 */
export async function stageDelivery(
  catalog: LibraryCatalog,
  request: { id: string; tier?: LibraryTier },
  storage: string,
  source: PackSource,
  net: LibraryNet,
): Promise<StagedDelivery> {
  const { entry, tier, files } = deliveryFiles(catalog, request.id, request.tier);
  const installed = await installFiles(storage, entry, files, source, net);
  const staged = path.join(storage, "jobs", randomUUID());
  await rm(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });
  for (const file of files) await copyFile(path.join(installed, file.name), path.join(staged, file.name));
  return { entry, tier, folder: `assets/library/${libraryFolder(entry.id)}`, staged, files };
}
