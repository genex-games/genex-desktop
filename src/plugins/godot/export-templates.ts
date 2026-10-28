/**
 * Godot's export templates, fetched for the person so a web or app export never waits on Godot's
 * Export Template Manager. For an official stable Godot, the release's templates archive
 * (`Godot_v<version>-stable_export_templates.tpz`, about 1.3 GB) is read from Godot's own GitHub
 * release by byte ranges: its central directory, then only the templates asked for (the Web
 * template is 10 MB). Each is inflated, checked against the archive's own CRC-32 and size, and
 * written whole into the person's templates folder for that version, where the Template Manager
 * puts them, beside the archive's `version.txt`. A template already there is kept.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { SECOND_MS } from "../../shared/duration.ts";
import { writeFileNoFollow } from "../../substrate/fsx.ts";
import { type GodotInstall, versionName } from "./find-godot.ts";

/** Godot's own releases on GitHub: the only place templates come from. */
const RELEASES = "https://github.com/godotengine/godot/releases/download";
/** The archive's folder holding the templates, and the file naming their version. */
const ARCHIVE_FOLDER = "templates";
const VERSION_FILE = "version.txt";
/** A zip's end-of-directory record, a central directory entry and a local file header, by their signatures. */
const END_SIGNATURE = 0x06054b50;
const ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** How far from the archive's end its end record is looked for: the record and the longest comment. */
const END_SEARCH_BYTES = 70_000;
/** A value a ZIP64 archive writes where it keeps the real one elsewhere: not read here. */
const ZIP64_MARK = 0xffffffff;
const STORED = 0;
const DEFLATED = 8;
/** The fixed parts of an end record, a central entry and a local header. */
const END_BYTES = 22;
const ENTRY_BYTES = 46;
const LOCAL_BYTES = 30;
/** The largest central directory and the largest template read: the archive's is a few KB, macOS's template 125 MB. */
const DIRECTORY_MAX_BYTES = 1024 * 1024;
const TEMPLATE_MAX_BYTES = 512 * 1024 * 1024;
const PARTIAL = ".partial";
/** A request's own deadline: this long, plus the time its bytes take at the slowest rate allowed. */
const REQUEST_BASE_MS = 30 * SECOND_MS;
const SLOWEST_BYTES_PER_SECOND = 256 * 1024;
/** How many times one request is made before the fetch gives up: once, then twice again. */
const REQUEST_TRIES = 3;
/** A range the server answered: `bytes <first>-<last>/<size>`. */
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/** Godot's template files Genex fetches, by what they export. Wire values: Godot's own file names. */
export const ExportTemplate = {
  /** The Web export without threads, as Genex's Web preset uses it. */
  Web: "web_nothreads_release.zip",
  WindowsX64: "windows_release_x86_64.exe",
  WindowsX64Console: "windows_release_x86_64_console.exe",
  Mac: "macos.zip",
  LinuxX64: "linux_release.x86_64",
} as const;
export type ExportTemplate = (typeof ExportTemplate)[keyof typeof ExportTemplate];

/** What an app or web build exports for, as the agent names it. Wire values: never rename one. */
export const ExportPlatform = { Web: "web", Windows: "windows", Mac: "mac", Linux: "linux" } as const;
export type ExportPlatform = (typeof ExportPlatform)[keyof typeof ExportPlatform];

/**
 * The templates each export needs: a Windows app's release build with its console twin, a Mac app's
 * one archive, a Linux app's 64-bit x86 release build.
 */
export const PLATFORM_TEMPLATES: Readonly<Record<ExportPlatform, readonly ExportTemplate[]>> = {
  [ExportPlatform.Web]: [ExportTemplate.Web],
  [ExportPlatform.Windows]: [ExportTemplate.WindowsX64, ExportTemplate.WindowsX64Console],
  [ExportPlatform.Mac]: [ExportTemplate.Mac],
  [ExportPlatform.Linux]: [ExportTemplate.LinuxX64],
};

/**
 * The project setting a Mac export needs (Godot refuses a universal or Apple-silicon build without
 * ETC2/ASTC textures), in its section of `project.godot`.
 */
const RENDERING_SECTION = "[rendering]";
const MAC_TEXTURES = "textures/vram_compression/import_etc2_astc=true";
const MAC_TEXTURES_KEY = "textures/vram_compression/import_etc2_astc=";

/** `project.godot`'s text with ETC2/ASTC textures imported, as a Mac export needs; unchanged when it says so. */
export function withMacTextures(settings: string): string {
  const lines = settings.split("\n");
  const said = lines.findIndex((line) => line.trim().startsWith(MAC_TEXTURES_KEY));
  if (said >= 0) {
    if (lines[said]?.trim() === MAC_TEXTURES) return settings;
    lines[said] = MAC_TEXTURES;
    return lines.join("\n");
  }
  const section = lines.findIndex((line) => line.trim() === RENDERING_SECTION);
  if (section >= 0) {
    // Godot writes a blank line under a section's heading; the setting goes after it.
    const blank = lines[section + 1]?.trim() === "" ? 1 : 0;
    lines.splice(section + 1 + blank, 0, MAC_TEXTURES);
    return lines.join("\n");
  }
  return `${settings.replace(/\s*$/, "")}\n\n${RENDERING_SECTION}\n\n${MAC_TEXTURES}\n`;
}

const MESSAGE = {
  NotOfficial: (version: string) =>
    `Godot ${version} isn't an official stable release, so Genex can't fetch its export templates: install them in Godot (Editor → Manage Export Templates).`,
  Download: (why: string) =>
    `Couldn't download Godot's export templates (${why}). Check your connection, then try again.`,
  Archive: "Godot's templates archive isn't one Genex can read.",
  Missing: (name: string) => `Godot's templates archive has no ${name}.`,
  Damaged: (name: string) => `Godot's ${name} arrived damaged; try again.`,
  NotRanged: (status: number) => `the server answered HTTP ${status} with the whole archive, not the part asked for`,
  TimedOut: "it took too long",
} as const;

/** One template's place in the archive: its local header, its sizes, how it is packed and its CRC-32. */
type ArchiveEntry = { local: number; packed: number; size: number; method: number; crc: number };

/** Where the templates come from: the network, with ranges. */
export type TemplateFetch = typeof fetch;

/** The official templates archive of a Godot, or null for a build that isn't an official stable one. */
export function templatesArchiveUrl(install: GodotInstall): string | null {
  const { version } = install;
  if (version.status !== "stable" || !/\.official\b/.test(version.text)) return null;
  const name = versionName(version);
  return `${RELEASES}/${name}-stable/Godot_v${name}-stable${version.mono ? "_mono" : ""}_export_templates.tpz`;
}

/** Where the templates come from and how a fetch of them is stopped: the network, with ranges. */
type Source = { fetcher: TemplateFetch; url: string; signal: AbortSignal | undefined };

/** A failure no second try mends (a server that ignores ranges, an archive Genex can't read). */
type Final = Error & { final: true };
const final = (message: string): Final => Object.assign(new Error(message), { final: true as const });
const isFinal = (error: unknown): error is Final => error instanceof Error && "final" in error;

/**
 * One request of the fetch, made again when it fails (the network, a timeout, a short answer), up
 * to {@link REQUEST_TRIES} times; never once the caller stopped, nor after a final failure. Each
 * try has its own deadline, by the bytes it reads (`bytes`).
 */
async function tried<T>(source: Source, bytes: number, ask: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    source.signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(requestMs(bytes));
    const signal = source.signal ? AbortSignal.any([source.signal, deadline]) : deadline;
    try {
      return await ask(signal);
    } catch (error) {
      if (source.signal?.aborted) throw source.signal.reason;
      if (isFinal(error)) throw new Error(error.message);
      if (attempt >= REQUEST_TRIES) throw new Error(MESSAGE.Download(failureWords(error, deadline)));
    }
  }
}

/** A request's deadline in whole milliseconds, by the bytes it reads. */
const requestMs = (bytes: number): number =>
  REQUEST_BASE_MS + Math.ceil((bytes / SLOWEST_BYTES_PER_SECOND) * SECOND_MS);

/** Why a try failed, in a few words. */
function failureWords(error: unknown, deadline: AbortSignal): string {
  if (deadline.aborted) return MESSAGE.TimedOut;
  return error instanceof Error ? error.message : String(error);
}

/** Whether a 206 answer is the range asked: its Content-Range names exactly `from` to `to`. */
function isRange(answer: Response, from: number, to: number): boolean {
  const named = CONTENT_RANGE.exec(answer.headers.get("content-range") ?? "");
  return answer.status === 206 && named !== null && Number(named[1]) === from && Number(named[2]) === to;
}

/**
 * Bytes `from` to `to` of the archive, as GitHub serves a range. An answer that isn't that range
 * (a whole archive from a server or proxy that ignores ranges) is refused before its body is read,
 * and its body cancelled.
 */
function range(source: Source, from: number, to: number): Promise<Buffer> {
  const length = to - from + 1;
  return tried(source, length, async (signal) => {
    const answer = await source.fetcher(source.url, { headers: { Range: `bytes=${from}-${to}` }, signal });
    if (!isRange(answer, from, to)) {
      await answer.body?.cancel().catch(() => undefined);
      const message = MESSAGE.Download(answer.ok ? MESSAGE.NotRanged(answer.status) : `HTTP ${answer.status}`);
      throw answer.ok ? final(message) : new Error(message);
    }
    const bytes = Buffer.from(await answer.arrayBuffer());
    if (bytes.length !== length) throw new Error(`${bytes.length} of ${length} bytes`);
    return bytes;
  });
}

/** The archive's size, from its headers. */
function archiveSize(source: Source): Promise<number> {
  return tried(source, 0, async (signal) => {
    const answer = await source.fetcher(source.url, { method: "HEAD", signal });
    const size = Number(answer.headers.get("content-length"));
    if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
    if (!Number.isSafeInteger(size) || size < END_BYTES) throw final(MESSAGE.Archive);
    return size;
  });
}

/** The archive's central directory, read through its end record, and the archive's size; a ZIP64 archive is refused. */
async function centralDirectory(source: Source): Promise<{ directory: Buffer; size: number }> {
  const size = await archiveSize(source);
  const start = Math.max(0, size - END_SEARCH_BYTES);
  const tail = await range(source, start, size - 1);
  let end = tail.length - END_BYTES;
  while (end >= 0 && tail.readUInt32LE(end) !== END_SIGNATURE) end -= 1;
  if (end < 0) throw new Error(MESSAGE.Archive);
  const length = tail.readUInt32LE(end + 12);
  const offset = tail.readUInt32LE(end + 16);
  const valid = offset !== ZIP64_MARK && length > 0 && length <= DIRECTORY_MAX_BYTES && offset + length <= size;
  if (!valid) throw new Error(MESSAGE.Archive);
  return { directory: await range(source, offset, offset + length - 1), size };
}

/** The archive's entries by name, from its central directory. */
function entriesOf(directory: Buffer): Map<string, ArchiveEntry> {
  const entries = new Map<string, ArchiveEntry>();
  for (let at = 0; at + ENTRY_BYTES <= directory.length; ) {
    if (directory.readUInt32LE(at) !== ENTRY_SIGNATURE) throw new Error(MESSAGE.Archive);
    const named = directory.readUInt16LE(at + 28);
    const name = directory.toString("utf8", at + ENTRY_BYTES, at + ENTRY_BYTES + named);
    entries.set(name, {
      method: directory.readUInt16LE(at + 10),
      crc: directory.readUInt32LE(at + 16),
      packed: directory.readUInt32LE(at + 20),
      size: directory.readUInt32LE(at + 24),
      local: directory.readUInt32LE(at + 42),
    });
    at += ENTRY_BYTES + named + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
  }
  return entries;
}

/** Whether an entry is one Genex reads: stored or deflated, within the sizes a template has, never ZIP64's. */
function readable(entry: ArchiveEntry): boolean {
  const known = entry.method === STORED || entry.method === DEFLATED;
  const fits = entry.packed !== ZIP64_MARK && entry.size <= TEMPLATE_MAX_BYTES && entry.packed <= TEMPLATE_MAX_BYTES;
  // A deflated entry is never empty: even no bytes deflate to some.
  const packs = entry.method !== DEFLATED || entry.packed > 0;
  return known && fits && packs;
}

/**
 * One entry's bytes, read past its local header, inflated and checked against its size and CRC-32;
 * one whose header or bytes would lie past the archive's end (`size`) is refused before it is asked for.
 */
async function entryBytes(source: Source, size: number, name: string, entry: ArchiveEntry): Promise<Buffer> {
  if (!readable(entry) || entry.local + LOCAL_BYTES > size) throw new Error(MESSAGE.Archive);
  const header = await range(source, entry.local, entry.local + LOCAL_BYTES - 1);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(MESSAGE.Archive);
  const start = entry.local + LOCAL_BYTES + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.packed > size) throw new Error(MESSAGE.Archive);
  const packed = entry.packed ? await range(source, start, start + entry.packed - 1) : Buffer.alloc(0);
  const bytes = entry.method === DEFLATED ? inflated(packed, name) : packed;
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw new Error(MESSAGE.Damaged(name));
  return bytes;
}

/** A deflated entry's bytes, or a damaged template when they don't inflate. */
function inflated(packed: Buffer, name: string): Buffer {
  try {
    return inflateRawSync(packed, { maxOutputLength: TEMPLATE_MAX_BYTES });
  } catch {
    throw new Error(MESSAGE.Damaged(name));
  }
}

/** Whether `file` is there as a plain file (a link is not one). */
const isFile = async (file: string) => (await lstat(file).catch(() => null))?.isFile() === true;

/**
 * A file written whole: beside its place first, under a name of this write's own (two fetches at
 * once never share one), then moved in, never through a link.
 */
async function writeWhole(file: string, bytes: Buffer): Promise<void> {
  const partial = `${file}.${randomUUID()}${PARTIAL}`;
  try {
    await writeFileNoFollow(partial, bytes);
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
  }
}

/**
 * The templates asked for in `folder` (the person's templates folder for `install`'s version),
 * each fetched from Godot's archive unless it is already there, with the archive's `version.txt`.
 * Answers the names it fetched; refuses a Godot that isn't an official stable release. `signal`
 * stops the fetch; each request also has its own deadline and is tried again when it fails.
 */
export async function fetchTemplates(
  fetcher: TemplateFetch,
  install: GodotInstall,
  folder: string,
  names: readonly ExportTemplate[],
  signal?: AbortSignal,
): Promise<string[]> {
  const missing: string[] = [];
  for (const name of names) if (!(await isFile(path.join(folder, name)))) missing.push(name);
  if (missing.length === 0) return [];
  const url = templatesArchiveUrl(install);
  if (!url) throw new Error(MESSAGE.NotOfficial(install.version.text));
  const source: Source = { fetcher, url, signal };
  const { directory, size } = await centralDirectory(source);
  const entries = entriesOf(directory);
  await mkdir(folder, { recursive: true });
  for (const name of [...missing, VERSION_FILE]) {
    const entry = entries.get(`${ARCHIVE_FOLDER}/${name}`);
    if (!entry) throw new Error(MESSAGE.Missing(name));
    if (name === VERSION_FILE && (await isFile(path.join(folder, name)))) continue;
    await writeWhole(path.join(folder, name), await entryBytes(source, size, name, entry));
  }
  return missing;
}
