/**
 * A native build's archive downloaded to disk: streamed, never held in memory, from an https address
 * on a build host the app trusts, every redirect checked again, never past its stated size, and
 * given up once it stops moving. A large archive is asked for as ranges over several connections
 * at once, each pinned to the archive the host first named (`If-Range`) and written at its own
 * offset, with a record beside the partial file (`native-range-record.ts`) so a later try asks only
 * for the ranges it lacks; an answer that is not exactly the range asked for is never written, and
 * the archive is then downloaded again as one stream, which resumes from the bytes already saved
 * when the host answers the range. Nothing is trusted until its sha256 matches (`verifyArchive`).
 * A chunked build's manifest and chunks come whole into memory by the same rules ({@link downloadBytes}).
 * Electron-free: the fetch is a dep, the network or a fixture's own files.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, open, rm, stat, truncate } from "node:fs/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { InstallFailure, type NativeBuild, type ZipBuild } from "../../shared/play-native.ts";
import {
  believedRanges,
  hasRangeRecord,
  newRangeRecord,
  type RangeShape,
  rangeCount,
  rangeSpan,
  readRangeRecord,
  removeRangeRecord,
  writeRangeRecord,
} from "./native-range-record.ts";
import { type StallClock, stallGuard } from "./remix.ts";

export { rangeRecordOf } from "./native-range-record.ts";

/** How many ranges of one archive are downloaded at once. */
export const DOWNLOAD_CONNECTIONS = 6;
/** The bytes asked for in one range. */
export const RANGE_BYTES = 32 * 1024 ** 2;
/** The fewest ranges an archive must span to be downloaded as ranges; a smaller one is one stream. */
const RANGED_MIN_RANGES = 2;
/** The one byte asked for first, to learn whether the host answers ranges and what it calls the archive. */
const PROBE_RANGE = "bytes=0-0";
/** How a weak ETag starts: `If-Range` takes only a strong one. */
const WEAK_ETAG = "W/";
/** The most redirects one download follows. */
const MAX_REDIRECTS = 5;
/** HTTP statuses read here. */
const HTTP_OK = 200;
const HTTP_PARTIAL = 206;
const HTTP_RANGE_NOT_SATISFIABLE = 416;
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** How long a download may go without a byte before it is given up. */
export const DOWNLOAD_STALL_MS = 60 * SECOND_MS;

/** A download or check that failed, with the install failure it is. */
export class InstallError extends Error {
  readonly failure: InstallFailure;
  constructor(failure: InstallFailure, detail?: string) {
    super(detail ? `${failure}: ${detail}` : failure);
    this.failure = failure;
  }
}

/** What a download needs: the fetch, the build hosts, and how a stall is timed. */
export interface DownloadDeps {
  fetch: typeof fetch;
  hosts: ReadonlySet<string>;
  stallClock?: StallClock;
  stallMs?: number;
  /** The bytes of one range ({@link RANGE_BYTES} unless a test says otherwise). */
  rangeBytes?: number;
}

/** How far a download has come: bytes saved and the whole size. */
export type DownloadReport = (received: number, total: number) => void;

/** An address a download may follow: https on a trusted build host, no port and no credentials. */
export function checkedBuildUrl(raw: string, hosts: ReadonlySet<string>, base?: string): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new InstallError(InstallFailure.Network, "not an address");
  }
  const plain = url.protocol === "https:" && url.port === "" && !url.username && !url.password;
  if (!plain || !hosts.has(url.hostname)) throw new InstallError(InstallFailure.Network, `refused ${url.origin}`);
  return url;
}

/** The archive's answer, following only redirects that stay on the build hosts over https. */
async function fetchChecked(deps: DownloadDeps, url: URL, headers: Record<string, string>, signal: AbortSignal) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await deps.fetch(current.href, { redirect: "manual", headers, signal });
    if (!REDIRECTS.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (!location) throw new InstallError(InstallFailure.Network, "redirect without a location");
    current = checkedBuildUrl(location, deps.hosts, current.href);
  }
  throw new InstallError(InstallFailure.Network, "too many redirects");
}

/**
 * A small object of a build (a chunked build's manifest, one chunk) downloaded whole into memory
 * from `url`, by the rules an archive is: build hosts only, every redirect checked, given up once it
 * stops moving. Only a plain 200 is read, never more than `maxBytes`: a longer answer throws
 * `too-large` once it passes that, an answer shorter than it says it is throws `network`.
 */
export async function downloadBytes(
  deps: DownloadDeps,
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const guard = stallGuard(deps.stallClock, deps.stallMs ?? DOWNLOAD_STALL_MS);
  try {
    const response = await fetchChecked(deps, url, {}, AbortSignal.any([signal, guard.signal]));
    if (response.status !== HTTP_OK) {
      await response.body?.cancel().catch(() => undefined);
      throw new InstallError(InstallFailure.Network, `HTTP ${response.status}`);
    }
    const length = declaredLength(response);
    if (length !== null && !(length <= maxBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new InstallError(InstallFailure.TooLarge, "longer than allowed");
    }
    if (!response.body) throw new InstallError(InstallFailure.Network, "no body");
    guard.moved();
    const parts: Uint8Array[] = [];
    let received = 0;
    for await (const part of response.body) {
      guard.moved();
      received += part.byteLength;
      if (received > maxBytes) throw new InstallError(InstallFailure.TooLarge, "longer than allowed");
      parts.push(part);
    }
    if (length !== null && received !== length) throw new InstallError(InstallFailure.Network, "ended early");
    return Buffer.concat(parts, received);
  } catch (error) {
    throw failureOf(error, guard.signal, signal);
  } finally {
    guard.stop();
  }
}

/** Bytes of `partial` already saved: none when it is missing, and none (it is deleted) when longer than the archive. */
async function savedBytes(partial: string, size: number): Promise<number> {
  const saved = (await stat(partial).catch(() => null))?.size ?? 0;
  if (saved <= size) return saved;
  await rm(partial, { force: true });
  return 0;
}

/** Where a resumed answer must start and what whole size it must name. */
function resumesAt(response: Response, offset: number, size: number): boolean {
  const range = response.headers.get("content-range");
  return range === `bytes ${offset}-${size - 1}/${size}`;
}

/** The byte count an answer says it carries, or null when it does not say. */
function declaredLength(response: Response): number | null {
  const value = response.headers.get("content-length");
  if (value === null) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : Number.NaN;
}

/** The offset the answer continues from (0 when the host sent the whole archive), or a throw. */
function startOf(response: Response, offset: number, size: number): number {
  if (response.status === HTTP_PARTIAL) {
    if (!resumesAt(response, offset, size)) throw new InstallError(InstallFailure.Network, "wrong range");
    return offset;
  }
  if (!response.ok) throw new InstallError(InstallFailure.Network, `HTTP ${response.status}`);
  return 0;
}

/** Copy `body` onto `partial` from `start`, never past `size`, reporting each step and every sign of life. */
async function saveBody(
  body: ReadableStream<Uint8Array>,
  partial: string,
  start: number,
  size: number,
  moved: () => void,
  report: DownloadReport,
): Promise<number> {
  const file = await open(partial, start > 0 ? "r+" : "w", 0o600);
  let offset = start;
  try {
    if (start === 0) await file.truncate(0);
    for await (const chunk of body) {
      moved();
      if (offset + chunk.byteLength > size) throw new InstallError(InstallFailure.TooLarge, "longer than stated");
      await file.write(chunk, 0, chunk.byteLength, offset);
      offset += chunk.byteLength;
      report(offset, size);
    }
  } finally {
    await file.close();
  }
  return offset;
}

/** What a failed fetch or read was, as an install failure: the stall, a stop, or the network. */
function failureOf(error: unknown, stalled: AbortSignal, stop: AbortSignal): InstallError {
  if (error instanceof InstallError) return error;
  if (stop.aborted) return new InstallError(InstallFailure.Failed, "stopped");
  if (stalled.aborted) return new InstallError(InstallFailure.Stalled);
  return new InstallError(InstallFailure.Network, error instanceof Error ? error.message : String(error));
}

/** One archive being downloaded: where from, where to, how large, and what stops it. */
interface Download {
  deps: DownloadDeps;
  url: URL;
  partial: string;
  size: number;
  signal: AbortSignal;
}

const stopped = (): InstallError => new InstallError(InstallFailure.Failed, "stopped");

/** Download the archive into `partial` as one stream, continuing from the bytes it holds when the host answers the range. */
async function downloadStream(job: Download, report: DownloadReport): Promise<void> {
  const { deps, url, partial, size, signal } = job;
  const offset = await savedBytes(partial, size);
  if (offset === size) return;
  const guard = stallGuard(deps.stallClock, deps.stallMs ?? DOWNLOAD_STALL_MS);
  const both = AbortSignal.any([signal, guard.signal]);
  try {
    const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    let response = await fetchChecked(deps, url, headers, both);
    if (response.status === HTTP_RANGE_NOT_SATISFIABLE) {
      // The saved bytes are not a prefix this host knows: start over.
      await response.body?.cancel().catch(() => undefined);
      response = await fetchChecked(deps, url, {}, both);
    }
    const start = startOf(response, offset, size);
    const length = declaredLength(response);
    if (length !== null && length !== size - start) throw new InstallError(InstallFailure.TooLarge, "wrong length");
    if (!response.body) throw new InstallError(InstallFailure.Network, "no body");
    guard.moved();
    const saved = await saveBody(response.body, partial, start, size, guard.moved, report);
    if (saved !== size) throw new InstallError(InstallFailure.Network, "ended early");
  } catch (error) {
    throw failureOf(error, guard.signal, signal);
  } finally {
    guard.stop();
  }
}

/** An answer that is not the range asked for: none of it is written, and the archive is downloaded as one stream. */
class NotTheRange extends Error {}

/**
 * What the host calls the archive, when it answers ranges of the archive stated: its strong ETag,
 * learned from one byte. Null when it answers anything else, so the archive is one stream.
 */
async function probeRanges(job: Download): Promise<string | null> {
  const guard = stallGuard(job.deps.stallClock, job.deps.stallMs ?? DOWNLOAD_STALL_MS);
  try {
    const both = AbortSignal.any([job.signal, guard.signal]);
    const response = await fetchChecked(job.deps, job.url, { Range: PROBE_RANGE }, both);
    await response.body?.cancel().catch(() => undefined);
    const ranged =
      response.status === HTTP_PARTIAL && response.headers.get("content-range") === `bytes 0-0/${job.size}`;
    const etag = response.headers.get("etag");
    return ranged && etag && !etag.startsWith(WEAK_ETAG) ? etag : null;
  } catch (error) {
    throw failureOf(error, guard.signal, job.signal);
  } finally {
    guard.stop();
  }
}

/**
 * The ranges of `shape` the partial file already holds, written down as the record before any
 * range is saved: the record's when it is to be believed, the whole ranges of a single stream's
 * saved bytes when there is no record, and none (the file emptied) otherwise.
 */
async function savedRanges(job: Download, shape: RangeShape, etag: string): Promise<number[]> {
  const { partial, size } = job;
  const saved = (await stat(partial).catch(() => null))?.size ?? 0;
  let done = believedRanges(await readRangeRecord(partial, shape), etag, saved);
  if (!done && !(await hasRangeRecord(partial)) && saved <= size) {
    done = Array.from({ length: Math.floor(saved / shape.rangeBytes) }, (_, index) => index);
  }
  await writeRangeRecord(partial, newRangeRecord(shape, etag, done ?? []));
  // "a" makes the file when it is missing and keeps what it holds.
  await (await open(partial, "a", 0o600)).close();
  // Emptied by its path, never through that handle: Windows refuses to truncate a file opened
  // for appending (EPERM), and a download whose record is not believed would then fail there.
  if (!done) await truncate(partial, 0);
  return done ?? [];
}

/** Whether an answer is exactly range `first`–`last` of the archive named `etag`. */
function isTheRange(response: Response, span: { first: number; last: number }, size: number, etag: string): boolean {
  if (response.status !== HTTP_PARTIAL || response.headers.get("etag") !== etag) return false;
  if (response.headers.get("content-range") !== `bytes ${span.first}-${span.last}/${size}`) return false;
  const length = declaredLength(response);
  return length === null || length === span.last - span.first + 1;
}

/** What saving ranges shares: the open partial file, the archive's name, and what stops every connection. */
interface RangeRun {
  job: Download;
  shape: RangeShape;
  file: FileHandle;
  etag: string;
  /** Aborted once any range fails: the other connections stop. */
  group: AbortController;
  wrote(bytes: number): void;
}

/** Save one range at its offset over its own connection, given up once it stops moving. */
async function saveRange(run: RangeRun, index: number): Promise<void> {
  const { job, file, etag } = run;
  const span = rangeSpan(index, run.shape);
  const guard = stallGuard(job.deps.stallClock, job.deps.stallMs ?? DOWNLOAD_STALL_MS);
  const all = AbortSignal.any([job.signal, run.group.signal, guard.signal]);
  try {
    const headers = { Range: `bytes=${span.first}-${span.last}`, "If-Range": etag };
    const response = await fetchChecked(job.deps, job.url, headers, all);
    if (!isTheRange(response, span, job.size, etag)) {
      await response.body?.cancel().catch(() => undefined);
      throw new NotTheRange();
    }
    if (!response.body) throw new InstallError(InstallFailure.Network, "no body");
    guard.moved();
    let offset = span.first;
    for await (const chunk of response.body) {
      guard.moved();
      if (offset + chunk.byteLength > span.last + 1) throw new NotTheRange();
      await file.write(chunk, 0, chunk.byteLength, offset);
      offset += chunk.byteLength;
      run.wrote(chunk.byteLength);
    }
    if (offset !== span.last + 1) throw new InstallError(InstallFailure.Network, "ended early");
    // The range is recorded as saved next: its bytes reach the disk first.
    await file.datasync();
  } catch (error) {
    if (error instanceof NotTheRange) throw error;
    throw failureOf(error, guard.signal, job.signal);
  } finally {
    guard.stop();
  }
}

/**
 * Save the ranges not in `done` over {@link DOWNLOAD_CONNECTIONS} connections, lowest first (so a
 * file system without sparse files fills little ahead of what is saved), recording each one once
 * it is whole. Answers the failures, first one first; the rest are the connections it stopped.
 */
async function saveRanges(run: RangeRun, done: number[]): Promise<unknown[]> {
  const have = new Set(done);
  const lacking = Array.from({ length: rangeCount(run.shape) }, (_, index) => index).filter(
    (index) => !have.has(index),
  );
  const failures: unknown[] = [];
  let next = 0;
  let recorded: Promise<void> = Promise.resolve();
  const record = (): Promise<void> => {
    const now = newRangeRecord(run.shape, run.etag, done);
    recorded = recorded.then(() => writeRangeRecord(run.job.partial, now));
    return recorded;
  };
  const connection = async (): Promise<void> => {
    while (!run.group.signal.aborted && next < lacking.length) {
      const index = lacking[next++];
      if (index === undefined) return;
      try {
        await saveRange(run, index);
        done.push(index);
        await record();
      } catch (error) {
        failures.push(error);
        run.group.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_CONNECTIONS }, connection));
  return failures;
}

/**
 * Download the archive as ranges. True once every range is saved; false when the host does not
 * answer ranges of this archive, or answered one with something else: the caller downloads it as
 * one stream. A stop, a stall, the network or a refused address throws, the saved ranges recorded.
 */
async function downloadRanges(job: Download, rangeBytes: number, report: DownloadReport): Promise<boolean> {
  const etag = await probeRanges(job);
  if (etag === null) return false;
  const shape: RangeShape = { sizeBytes: job.size, rangeBytes };
  const done = await savedRanges(job, shape, etag);
  let received = done.reduce((sum, index) => sum + rangeSpan(index, shape).last - rangeSpan(index, shape).first + 1, 0);
  if (received > 0) report(received, job.size);
  const wrote = (bytes: number) => {
    received += bytes;
    report(received, job.size);
  };
  const file = await open(job.partial, "r+");
  let failures: unknown[];
  try {
    failures = await saveRanges({ job, shape, file, etag, group: new AbortController(), wrote }, done);
  } finally {
    await file.close();
  }
  if (job.signal.aborted) throw stopped();
  if (failures.some((failure) => failure instanceof NotTheRange)) return false;
  if (failures.length > 0) throw failureOf(failures[0], new AbortController().signal, job.signal);
  await removeRangeRecord(job.partial);
  return true;
}

/** Throw away what a download saved: the partial file and the record of its ranges. */
export async function discardDownload(partial: string): Promise<void> {
  await rm(partial, { force: true });
  await removeRangeRecord(partial);
}

/**
 * Download `build`'s archive into `partial` and answer once all of `build.sizeBytes` are saved: as
 * ranges over several connections when it is large and the host answers them, else as one stream.
 * Either way a later call continues from what is saved. A stop (`signal`) throws and leaves the
 * saved bytes and their record where they are, for the caller to keep or throw away
 * ({@link discardDownload}; the installer throws a cancelled install's away); a refused address, a
 * stall, the network or an answer longer than stated throws {@link InstallError}. `report` never
 * goes back: after ranges are given up for one stream it holds until the stream passes it.
 */
export async function downloadArchive(
  deps: DownloadDeps,
  build: ZipBuild,
  partial: string,
  signal: AbortSignal,
  report: DownloadReport,
): Promise<void> {
  const size = build.sizeBytes;
  const url = checkedBuildUrl(build.url, deps.hosts);
  if (signal.aborted) throw stopped();
  const job: Download = { deps, url, partial, size, signal };
  const rangeBytes = deps.rangeBytes ?? RANGE_BYTES;
  const recorded = await hasRangeRecord(partial);
  if (!recorded && (await savedBytes(partial, size)) === size) return;
  let most = 0;
  const rising: DownloadReport = (received, total) => {
    most = Math.max(most, received);
    report(most, total);
  };
  if (size >= RANGED_MIN_RANGES * rangeBytes && (await downloadRanges(job, rangeBytes, rising))) return;
  // Bytes saved as ranges are no prefix one stream could continue from.
  if (await hasRangeRecord(partial)) await discardDownload(partial);
  await downloadStream(job, rising);
}

/** Whether `file` is `build`'s archive: its exact size and sha256. */
export async function verifyArchive(file: string, build: Pick<NativeBuild, "sizeBytes" | "sha256">): Promise<boolean> {
  if ((await stat(file).catch(() => null))?.size !== build.sizeBytes) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex") === build.sha256;
}
