/**
 * A native build's archive downloaded to disk: streamed, never held in memory, from an https address
 * on a build host the app trusts, every redirect checked again, never past its stated size, resumed
 * from the bytes already saved when the host answers ranges, and given up once it stops moving.
 * Nothing is trusted until its sha256 matches (`verifyArchive`). Electron-free: the fetch is a dep,
 * the network or a fixture's own files.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { InstallFailure, type NativeBuild } from "../../shared/play-native.ts";
import { type StallClock, stallGuard } from "./remix.ts";

/** The most redirects one download follows. */
const MAX_REDIRECTS = 5;
/** HTTP statuses read here. */
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
function failureOf(error: unknown, stalled: AbortSignal, stopped: AbortSignal): InstallError {
  if (error instanceof InstallError) return error;
  if (stopped.aborted) return new InstallError(InstallFailure.Failed, "stopped");
  if (stalled.aborted) return new InstallError(InstallFailure.Stalled);
  return new InstallError(InstallFailure.Network, error instanceof Error ? error.message : String(error));
}

/**
 * Download `build`'s archive into `partial`, continuing from the bytes it already holds when the
 * host answers the range, and answer once all of `build.sizeBytes` are saved. A stop (`signal`)
 * keeps the bytes for later; a refused address, a stall, the network or an answer longer than
 * stated throws {@link InstallError}.
 */
export async function downloadArchive(
  deps: DownloadDeps,
  build: NativeBuild,
  partial: string,
  signal: AbortSignal,
  report: DownloadReport,
): Promise<void> {
  const size = build.sizeBytes;
  const url = checkedBuildUrl(build.url, deps.hosts);
  if (signal.aborted) throw new InstallError(InstallFailure.Failed, "stopped");
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

/** Whether `file` is `build`'s archive: its exact size and sha256. */
export async function verifyArchive(file: string, build: NativeBuild): Promise<boolean> {
  if ((await stat(file).catch(() => null))?.size !== build.sizeBytes) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex") === build.sha256;
}
