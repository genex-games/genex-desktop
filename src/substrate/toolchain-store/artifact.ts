/**
 * A folder Genex built (ANGLE) pinned by its `manifest.json`: the manifest's own size and sha256
 * are the pin, and it lists every other file's path, size and sha256. The store verifies such a
 * folder before it copies anything out of it (a developer's local artifact, or the copy the app
 * bundles in its resources), and `scripts/bundle-angle.mjs` verifies the build's sources the same
 * way. A link, a FIFO or any other special file, a file the manifest does not list, a listed one
 * that is missing or differs, and a manifest path that is absolute or climbs out are refused with a
 * typed {@link ArtifactFault}.
 *
 * The Mac ANGLE libraries the app bundles are code: a Developer ID build's signing walk re-signs
 * them, which rewrites their signature and the two load-command fields that size it. The bundle
 * keeps, per library, the original header and signature (`signatures.json`, a
 * {@link SignatureRecord} each), so the store restores the pinned bytes and holds them to the
 * manifest's sha256 like any other file: nothing re-signed is ever accepted as it is.
 */
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { ToolchainError, ToolchainProblem } from "../../shared/toolchain.ts";
import { isJsonObject, openNoFollow, readRegularFile } from "../fsx.ts";

/** The file an artifact folder is pinned by: every other file's path, size and sha256. */
export const ARTIFACT_MANIFEST_FILE = "manifest.json";
/** Beside a bundled Mac ANGLE's manifest: each library's original header and signature, base64. */
export const SIGNATURES_FILE = "signatures.json";
/** The most of a `manifest.json` or `signatures.json` the store reads. */
const SIDE_FILE_MAX_BYTES = 1024 * 1024;
/** How much bigger a re-signed library may be than its pinned size: a Developer ID signature with its certificates. */
const SIGNATURE_GROWTH_MAX_BYTES = 1024 * 1024;

/** Why an artifact folder was refused. Wire values: never rename one. */
export const ArtifactFault = {
  /** The folder or its `manifest.json` is not there. */
  Missing: "missing",
  /** A link, a FIFO, a socket or a device where a plain file or folder must be. */
  NotRegular: "not-regular",
  /** A file the manifest does not list. */
  Unlisted: "unlisted",
  /** A manifest path that is absolute, climbs out or is not plain. */
  BadPath: "bad-path",
  /** `manifest.json` is not the pinned one (size or sha256). */
  ManifestDigest: "manifest-digest",
  /** `manifest.json` does not list its files as the pin records them, or `signatures.json` is malformed. */
  ManifestShape: "manifest-shape",
  /** The manifest names another ANGLE commit or build target than the one expected. */
  Origin: "origin",
  /** A listed file is not in the folder. */
  FileMissing: "file-missing",
  /** A listed file's size or sha256 is not its manifest's (after restoring a re-signed library). */
  FileDigest: "file-digest",
} as const;
export type ArtifactFault = (typeof ArtifactFault)[keyof typeof ArtifactFault];

/**
 * The install problem each fault reports: a build made without the component is `not-bundled`;
 * refusing what may not be copied is `archive`, as for a download that would unpack outside its
 * folder; content that is not the pin's is `integrity`.
 */
export const ARTIFACT_FAULT_PROBLEM = {
  [ArtifactFault.Missing]: ToolchainProblem.NotBundled,
  [ArtifactFault.NotRegular]: ToolchainProblem.Archive,
  [ArtifactFault.Unlisted]: ToolchainProblem.Archive,
  [ArtifactFault.BadPath]: ToolchainProblem.Archive,
  [ArtifactFault.ManifestDigest]: ToolchainProblem.Integrity,
  [ArtifactFault.ManifestShape]: ToolchainProblem.Integrity,
  [ArtifactFault.Origin]: ToolchainProblem.Integrity,
  [ArtifactFault.FileMissing]: ToolchainProblem.Integrity,
  [ArtifactFault.FileDigest]: ToolchainProblem.Integrity,
} as const satisfies Record<ArtifactFault, ToolchainProblem>;

const MESSAGE = {
  Missing: (what: string) => `${what} is not there.`,
  NotRegular: (rel: string) =>
    `${rel} is a link, a FIFO or another special file; only plain files and folders are copied.`,
  BadPath: (rel: string) => `manifest.json names ${JSON.stringify(rel)}, which is not a plain path inside the folder.`,
  Unlisted: (rel: string) => `${rel} is in the folder but not in its manifest.json.`,
  FileMissing: (rel: string) => `${rel} is listed in manifest.json but not in the folder.`,
  FileDigest: (rel: string) => `${rel} does not match its manifest.json size and sha256.`,
  ManifestDigest: (folder: string) => `${folder}/manifest.json is not the pinned one.`,
  ManifestShape: (folder: string) => `${folder}/manifest.json does not list its files as the pin records them.`,
  Signatures: (folder: string) => `${folder}/signatures.json is not a table of library signatures.`,
  Origin: (field: string, found: unknown, expected: string) =>
    `manifest.json names ${field} ${JSON.stringify(found)}, not ${expected}.`,
} as const;

/** A refused artifact folder: the install problem it reports, and the fault that caused it. */
export class ArtifactError extends ToolchainError {
  readonly fault: ArtifactFault;

  constructor(fault: ArtifactFault, message: string) {
    super(ARTIFACT_FAULT_PROBLEM[fault], message);
    this.name = "ArtifactError";
    this.fault = fault;
  }
}

/** What pins an artifact folder: its `manifest.json`'s sha256 and size, and the count and total size of the files it lists. */
export interface ArtifactPin {
  manifestSha256: string;
  manifestBytes: number;
  files: number;
  bytes: number;
}

/** One file a `manifest.json` lists. */
export interface ListedFile {
  /** `/`-separated, inside the folder. */
  rel: string;
  size: number;
  sha256: string;
}

/** A folder's pinned `manifest.json`: its bytes, its parsed fields and the files it lists. */
export interface PinnedManifest {
  bytes: Buffer;
  fields: Record<string, unknown>;
  files: ListedFile[];
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The sha256 of `bytes`, in lowercase hex. */
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** `bytes` as JSON, or null when they are not JSON. */
function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Whether `rel` is a plain relative path: no root, no `..`, `.` or empty segment, no backslash or control character. */
export function isPlainPath(rel: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (rel === "" || rel.startsWith("/") || /[\\\x00-\x1f]/.test(rel)) return false;
  return rel.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** A side file (`manifest.json`, `signatures.json`) read without following a link or blocking; null when absent. */
async function readSideFile(folder: string, name: string): Promise<Buffer | null> {
  const at = path.join(folder, name);
  if (!(await lstat(at).catch(() => null))) return null;
  return readRegularFile(at, SIDE_FILE_MAX_BYTES).catch(() => {
    throw new ArtifactError(ArtifactFault.NotRegular, MESSAGE.NotRegular(name));
  });
}

/** One `files` entry of a manifest, shape-checked. */
function listedFile(folder: string, rel: string, fact: unknown): ListedFile {
  if (!isPlainPath(rel) || rel === ARTIFACT_MANIFEST_FILE || rel === SIGNATURES_FILE)
    throw new ArtifactError(ArtifactFault.BadPath, MESSAGE.BadPath(rel));
  const shaped = isJsonObject(fact) && typeof fact.sha256 === "string" && SHA256.test(fact.sha256);
  if (!shaped || !Number.isSafeInteger(fact.size) || (fact.size as number) < 0)
    throw new ArtifactError(ArtifactFault.ManifestShape, MESSAGE.ManifestShape(folder));
  return { rel, size: fact.size as number, sha256: fact.sha256 as string };
}

/**
 * The pinned `manifest.json` of `folder`: read without following a link (a FIFO, a link or an
 * oversize file is refused without blocking), its size and sha256 the pin's, and its `files`
 * listing exactly the pinned count and bytes, each at a plain path.
 */
export async function readPinnedManifest(folder: string, pin: ArtifactPin): Promise<PinnedManifest> {
  const bytes = await readSideFile(folder, ARTIFACT_MANIFEST_FILE);
  if (!bytes) throw new ArtifactError(ArtifactFault.Missing, MESSAGE.Missing(`${folder}/${ARTIFACT_MANIFEST_FILE}`));
  if (bytes.length !== pin.manifestBytes || sha256Hex(bytes) !== pin.manifestSha256)
    throw new ArtifactError(ArtifactFault.ManifestDigest, MESSAGE.ManifestDigest(folder));
  const parsed = parseJson(bytes);
  const listed = isJsonObject(parsed) && isJsonObject(parsed.files) ? parsed.files : null;
  if (!isJsonObject(parsed) || !listed)
    throw new ArtifactError(ArtifactFault.ManifestShape, MESSAGE.ManifestShape(folder));
  const files = Object.entries(listed).map(([rel, fact]) => listedFile(folder, rel, fact));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length !== pin.files || total !== pin.bytes)
    throw new ArtifactError(ArtifactFault.ManifestShape, MESSAGE.ManifestShape(folder));
  return { bytes, fields: parsed, files };
}

/** Refuses a manifest that names another ANGLE commit (in full) or build target than `origin`. */
export function assertOrigin(manifest: PinnedManifest, origin: { commit: string; target: string }): void {
  const { commit, target } = manifest.fields;
  if (commit !== origin.commit)
    throw new ArtifactError(ArtifactFault.Origin, MESSAGE.Origin("commit", commit, origin.commit));
  if (target !== origin.target)
    throw new ArtifactError(ArtifactFault.Origin, MESSAGE.Origin("target", target, origin.target));
}

/**
 * Every regular file under `folder` (`/`-separated), walked without following a link; a link, a
 * FIFO, a socket or a device anywhere is refused before anything is opened.
 */
export async function plainFiles(folder: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(folder, ...rel.split("/").filter(Boolean)), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await plainFiles(folder, child)));
    else if (entry.isFile()) found.push(child);
    else throw new ArtifactError(ArtifactFault.NotRegular, MESSAGE.NotRegular(child));
  }
  return found;
}

/** The folder holds exactly the listed files and `manifest.json` (and `also`): none missing, none unlisted. */
export function assertExactly(
  present: readonly string[],
  files: readonly ListedFile[],
  also: readonly string[] = [],
): void {
  const listed = new Set(files.map((file) => file.rel));
  const allowed = new Set([ARTIFACT_MANIFEST_FILE, ...also]);
  const extra = present.find((rel) => !allowed.has(rel) && !listed.has(rel));
  if (extra !== undefined) throw new ArtifactError(ArtifactFault.Unlisted, MESSAGE.Unlisted(extra));
  const there = new Set(present);
  const missing = files.find((file) => !there.has(file.rel));
  if (missing) throw new ArtifactError(ArtifactFault.FileMissing, MESSAGE.FileMissing(missing.rel));
}

// ---------- Mach-O signatures ----------

/**
 * What restores a re-signed thin 64-bit Mach-O to its pinned bytes: its original load-command
 * region (`header`, base64), where its code ends and its signature begins (`codeLimit`), and its
 * original signature (`signature`, base64). Signing never changes the bytes between the two.
 */
export interface SignatureRecord {
  header: string;
  codeLimit: number;
  signature: string;
}

const MH_MAGIC_64 = 0xfeedfacf;
const MACH_HEADER_64_BYTES = 32;
const LC_CODE_SIGNATURE = 0x1d;
/** Where `mach_header_64` keeps `ncmds` and `sizeofcmds`. */
const NCMDS_OFFSET = 16;
const SIZEOFCMDS_OFFSET = 20;

/** Where a thin 64-bit little-endian Mach-O's load commands end and its signature begins, or null. */
function machOLayout(bytes: Buffer): { headerBytes: number; codeLimit: number } | null {
  if (bytes.length < MACH_HEADER_64_BYTES || bytes.readUInt32LE(0) !== MH_MAGIC_64) return null;
  const headerBytes = MACH_HEADER_64_BYTES + bytes.readUInt32LE(SIZEOFCMDS_OFFSET);
  if (headerBytes > bytes.length) return null;
  let at = MACH_HEADER_64_BYTES;
  for (let index = 0; index < bytes.readUInt32LE(NCMDS_OFFSET); index += 1) {
    if (at + 8 > headerBytes) return null;
    const command = bytes.readUInt32LE(at);
    const size = bytes.readUInt32LE(at + 4);
    if (size < 8) return null;
    if (command === LC_CODE_SIGNATURE && at + 16 <= headerBytes) {
      const codeLimit = bytes.readUInt32LE(at + 8);
      return codeLimit >= headerBytes && codeLimit <= bytes.length ? { headerBytes, codeLimit } : null;
    }
    at += size;
  }
  return null;
}

/** The record that restores `bytes` once re-signed, or null when they are not a signed thin 64-bit Mach-O. */
export function signatureRecord(bytes: Buffer): SignatureRecord | null {
  const layout = machOLayout(bytes);
  if (!layout) return null;
  return {
    header: bytes.subarray(0, layout.headerBytes).toString("base64"),
    codeLimit: layout.codeLimit,
    signature: bytes.subarray(layout.codeLimit).toString("base64"),
  };
}

/**
 * `signed` with its original load-command region and signature put back: the pinned bytes when
 * only the signature changed. Null when `signed` cannot hold the record's code.
 */
export function restoreSigned(signed: Buffer, record: SignatureRecord): Buffer | null {
  const header = Buffer.from(record.header, "base64");
  const signature = Buffer.from(record.signature, "base64");
  const fits = header.length <= record.codeLimit && record.codeLimit <= signed.length;
  if (!fits) return null;
  return Buffer.concat([header, signed.subarray(header.length, record.codeLimit), signature]);
}

const isSignatureRecord = (value: unknown): value is SignatureRecord =>
  isJsonObject(value) &&
  typeof value.header === "string" &&
  typeof value.signature === "string" &&
  Number.isSafeInteger(value.codeLimit) &&
  (value.codeLimit as number) >= 0;

/** A folder's `signatures.json` by listed file, or an empty table when it has none. */
export async function readSignatures(folder: string): Promise<Map<string, SignatureRecord>> {
  const bytes = await readSideFile(folder, SIGNATURES_FILE);
  if (!bytes) return new Map();
  const parsed = parseJson(bytes);
  const table = isJsonObject(parsed) && isJsonObject(parsed.files) ? parsed.files : null;
  if (!table || !Object.values(table).every(isSignatureRecord))
    throw new ArtifactError(ArtifactFault.ManifestShape, MESSAGE.Signatures(folder));
  return new Map(Object.entries(table as Record<string, SignatureRecord>));
}

// ---------- reading and copying listed files ----------

/**
 * A listed file's pinned bytes and mode: opened without following a link and without blocking (a
 * FIFO swapped in after the walk is refused, never waited on), checked to be a regular file, and
 * held to its listed size and sha256; a re-signed library with a `signature` record is restored
 * first. Anything else is refused.
 */
export async function readListed(
  folder: string,
  file: ListedFile,
  signature: SignatureRecord | null = null,
): Promise<{ bytes: Buffer; mode: number }> {
  const from = path.join(folder, ...file.rel.split("/"));
  const input = await openNoFollow(from, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => {
    throw new ArtifactError(ArtifactFault.NotRegular, MESSAGE.NotRegular(file.rel));
  });
  try {
    const info = await input.stat();
    if (!info.isFile()) throw new ArtifactError(ArtifactFault.NotRegular, MESSAGE.NotRegular(file.rel));
    const limit = file.size + (signature ? SIGNATURE_GROWTH_MAX_BYTES : 0);
    const read = info.size <= limit ? await readAtMost(input, limit) : null;
    if (!read) throw new ArtifactError(ArtifactFault.FileDigest, MESSAGE.FileDigest(file.rel));
    const restored = matches(read, file) || !signature ? read : restoreSigned(read, signature);
    if (!restored || !matches(restored, file))
      throw new ArtifactError(ArtifactFault.FileDigest, MESSAGE.FileDigest(file.rel));
    return { bytes: restored, mode: info.mode };
  } finally {
    await input.close();
  }
}

/** Everything `handle` holds, or null when it holds more than `limit` bytes (a file that grew while it was read). */
async function readAtMost(handle: FileHandle, limit: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(limit + 1);
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) return buffer.subarray(0, total);
    total += bytesRead;
    if (total > limit) return null;
  }
}

/** Whether `bytes` are exactly the listed file's. */
const matches = (bytes: Buffer, file: ListedFile) => bytes.length === file.size && sha256Hex(bytes) === file.sha256;

/** Copies one listed file's pinned bytes ({@link readListed}) into a new file under `into`, keeping its execute bits. */
export async function copyListed(
  folder: string,
  into: string,
  file: ListedFile,
  signature: SignatureRecord | null = null,
): Promise<void> {
  const { bytes, mode } = await readListed(folder, file, signature);
  const to = path.join(into, ...file.rel.split("/"));
  await mkdir(path.dirname(to), { recursive: true });
  await writeNew(to, bytes, mode & 0o755);
}

/** Writes a new file (never through a link: `wx` refuses one at its name). */
export async function writeNew(file: string, bytes: Uint8Array | string, mode = 0o644): Promise<void> {
  const handle = await open(file, "wx", mode);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
