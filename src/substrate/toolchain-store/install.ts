/**
 * Installing toolchain components into the store: preflight (pinned, https, disk), download with
 * the injected `fetch` (the main process's, never Chromium's downloader, so nothing is
 * quarantined), verify sha256, list and extract into a staging folder, probe the tool's version
 * under the sandbox, then swap the folder in with its receipt. A job is all or nothing: any
 * failure or a cancel removes what the job added. Older versions stay while any lock names them
 * (`pruneStore`).
 *
 * `bonsai/download.ts`'s `download()` is not reused: it calls the global `fetch` and `statfs`
 * itself, and a store install takes both injected so its rows run with no network. Its stall
 * guard is kept: a download that receives nothing for {@link STALL_TIMEOUT_MS} fails, on an
 * injectable timer.
 *
 * A component Genex builds itself (ANGLE, `ToolchainEntry.local`) is never downloaded. The app
 * bundles the pinned builds in its resources (`bundled.ts`), so an install copies ANGLE from there
 * ({@link installBundledArtifact}), verified against its pinned `manifest.json` file by file.
 * Linux's build headers are included the same way; any unbundled, unpublished artifact is refused
 * `not-hosted`. The developer's
 * store can also take one from a local folder ({@link installLocalArtifact}).
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type { BuildTarget } from "../../shared/game-project.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import {
  ANDROID_PINS,
  type ToolchainArchive,
  type ToolchainEntry,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  type ToolchainInstallJob,
  ToolchainInstallPhase,
  type ToolchainLocalArtifact,
  ToolchainProblem,
} from "../../shared/toolchain.ts";
import { listDirs } from "../fsx.ts";
import { LinuxVulkanFile } from "../native-runtime-files.ts";
import { type RunRequest, type RunResult, shellQuote } from "../spawn.ts";
import { extractArchive } from "./archive.ts";
import {
  ARTIFACT_MANIFEST_FILE,
  ArtifactError,
  ArtifactFault,
  assertExactly,
  assertOrigin,
  copyListed,
  plainFiles,
  readPinnedManifest,
  readSignatures,
  SIGNATURES_FILE,
  type SignatureRecord,
  writeNew,
} from "./artifact.ts";
import { appResourcesDir, BUNDLE_LOCK, type BundleLock, bundledFolder, bundledTargetOf, isBundled } from "./bundled.ts";
import { cachedDownload } from "./download-cache.ts";
import {
  COMPONENT_LAYOUT,
  componentFolder,
  EMSDK_BUNDLED,
  RECEIPT_FILE,
  RUST_COMPONENT_LAYOUT,
  readReceipt,
} from "./locate.ts";
import { isSafePin, LOCKS_FOLDER } from "./lock.ts";
import { entryDigest, entrySha12, isDownloadable } from "./manifest.ts";
import { bundledLinuxSysrootFolder, isBundledLinuxSysroot, verifyLinuxSysrootFolder } from "./linux-sysroot-bundle.ts";

const MESSAGE = {
  NotHttps: (url: string) => `Toolchains download over https only: ${url}`,
  NoSpace: (needed: number, free: number) =>
    `Not enough disk space for the toolchain download: ${Math.ceil(needed / 1024 ** 2)} MiB needed, ${Math.floor(free / 1024 ** 2)} MiB free.`,
  HttpFailed: (status: number, url: string) => `Download failed: HTTP ${status} for ${url}`,
  Unreachable: (url: string, detail: string) => `Download failed for ${url}: ${detail}`,
  Stalled: (url: string) =>
    `Download stalled: nothing arrived from ${url} for ${STALL_TIMEOUT_MS / SECOND_MS} seconds.`,
  Integrity: (url: string) => `Integrity check failed: ${url} does not match its pinned size and sha256.`,
  ProbeFailed: (id: string, detail: string) => `${id} did not run after installing: ${detail}`,
  ProbeMissing: (id: string, file: string) => `${id} is missing ${file} after installing.`,
  NotHosted: (id: string) => `${id} has no download yet: Genex built and pinned it but has not published it.`,
  NotLocal: (id: string) => `${id} is not pinned as a local artifact.`,
  NotBundled: (id: string, folder: string) => `${id} is not at ${folder}: this build of Genex was made without it.`,
  NotRegular: (rel: string) =>
    `${rel} is a link, a FIFO or another special file; only plain files and folders are copied.`,
  BadPin: (version: string, sha12: string) => `${version} at ${sha12} cannot name a store folder.`,
} as const;

/** Where an installed component came from. */
export const ReceiptSource = {
  /** Downloaded and verified against the manifest's pin. */
  Archive: "archive",
  /**
   * The developer's store only: a component Genex built (ANGLE) copied from a local folder that
   * matched its pinned `manifest.json`, file by file; it has no download yet.
   */
  LocalArtifact: "local-artifact",
  /** A component the app bundles (ANGLE) copied from its resources, verified against its pinned `manifest.json`. */
  Bundled: "bundled",
} as const;
export type ReceiptSource = (typeof ReceiptSource)[keyof typeof ReceiptSource];

/** `receipt.json` beside one installed component (`<store>/<id>/<version>-<sha12>/receipt.json`). */
export interface ToolchainReceipt {
  id: ToolchainId;
  version: string;
  /** The entry digest whose first 12 hex are `sha12` (one archive: its own sha256; a local artifact: its manifest.json's). */
  sha256: string;
  sha12: string;
  bytes: number;
  host: ToolchainHost | null;
  target: BuildTarget | null;
  source: ReceiptSource;
  installedAt: string;
}

/** What an install is given: the network, the sandbox, the disk and the progress sink, all injected. */
export interface InstallDeps {
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  run: (request: RunRequest) => Promise<RunResult>;
  freeBytes: (dir: string) => Promise<number>;
  onJob: (job: ToolchainInstallJob) => void;
  signal?: AbortSignal;
  now?: () => number;
  /** Runs `run` after `ms` and answers how to cancel it (the stall timer); `setTimeout` when absent. */
  schedule?: (run: () => void, ms: number) => () => void;
  /** The app's read-only resources (`paths.resources`), where bundled components are; {@link appResourcesDir} when absent. */
  resources?: string;
  /**
   * The host-level download cache every profile shares (`download-cache.ts`): archives are fetched
   * into it once and verified each time they are extracted from it. Absent: each download goes to
   * the store's own staging and is removed after extraction.
   */
  downloadCache?: string;
}

/** Free space kept beyond what an install is expected to take. */
export const DISK_RESERVE_BYTES = 256 * 1024 ** 2;
/** How much bigger an archive gets unpacked: zig's `.tar.xz` is the widest measured (~7.8×). */
const UNPACKED_FACTOR = 8;

/** The disk archives of `bytes` may take while they unpack, as the install's own space check counts it. */
export const unpackedBytes = (bytes: number): number => bytes * UNPACKED_FACTOR;
const PROBE_TIMEOUT_MS = 30 * SECOND_MS;
const PROGRESS_INTERVAL_MS = 150;
/** A download that receives nothing for this long fails, as `bonsai/download.ts`'s does. */
const STALL_TIMEOUT_MS = 60 * SECOND_MS;
/** Install and prewarm staging, inside the store so a swap is a rename on one volume. */
export const STAGING_FOLDER = ".staging";
const HTTPS = "https:";

// ---------- progress ----------

interface JobTracker {
  phase(phase: ToolchainInstallPhase, entry: ToolchainId | null): void;
  /** The entry the job is on. */
  entry(): ToolchainId | null;
  total(bytes: number): void;
  advance(bytes: number): void;
  finish(phase: ToolchainInstallPhase, problem?: ToolchainProblem): ToolchainInstallJob;
}

function jobTracker(onJob: (job: ToolchainInstallJob) => void, clock: () => number): JobTracker {
  const stamp = () => new Date(clock()).toISOString();
  const job: ToolchainInstallJob = {
    phase: ToolchainInstallPhase.Preflight,
    entry: null,
    completed: 0,
    total: 0,
    startedAt: stamp(),
  };
  let reported = 0;
  const emit = () => {
    reported = clock();
    onJob({ ...job });
  };
  return {
    phase(phase, entry) {
      job.phase = phase;
      job.entry = entry;
      emit();
    },
    entry: () => job.entry,
    total(bytes) {
      job.total = bytes;
    },
    advance(bytes) {
      job.completed += bytes;
      if (clock() - reported >= PROGRESS_INTERVAL_MS) emit();
    },
    finish(phase, problem) {
      job.phase = phase;
      if (problem) job.problem = problem;
      job.finishedAt = stamp();
      emit();
      return { ...job };
    },
  };
}

// ---------- preflight ----------

const isHttps = (url: string) => URL.canParse(url) && new URL(url).protocol === HTTPS;

/**
 * Refuses an entry that has no download (a local artifact the app does not bundle: `not-hosted`),
 * an unrecorded digest or a URL that is not https, before any fetch. A bundled one has no URL.
 */
function assertInstallable(entry: ToolchainEntry): void {
  if (entry.local && !isDownloadable(entry))
    throw new ToolchainError(ToolchainProblem.NotHosted, MESSAGE.NotHosted(entry.id));
  entryDigest(entry);
  const insecure = installArchives(entry).find((archive) => !isHttps(archive.url));
  if (insecure) throw new ToolchainError(ToolchainProblem.NotHttps, MESSAGE.NotHttps(insecure.url));
}

/** Whether the store already holds `entry` at its pin, with a matching receipt. */
async function isInstalled(store: string, entry: ToolchainEntry): Promise<boolean> {
  const sha12 = entrySha12(entry);
  const receipt = await readReceipt(componentFolder(store, entry.id, { version: entry.version, sha12 }));
  return receipt?.id === entry.id && receipt.sha12 === sha12 && receipt.sha256 === entryDigest(entry);
}

/** Local artifacts have two pins: the downloaded archive and its installed manifest. */
function installArchives(entry: ToolchainEntry): readonly ToolchainArchive[] {
  const fetch = entry.local?.fetch;
  return fetch?.url ? [{ ...fetch, url: fetch.url, strip: 0, into: "" }] : entry.archives;
}

const archiveBytes = (entries: readonly ToolchainEntry[]) =>
  entries.reduce((sum, entry) => sum + installArchives(entry).reduce((bytes, archive) => bytes + archive.bytes, 0), 0);

/** The bytes the bundled ones among `entries` copy from the app's resources. */
const bundledBytes = (entries: readonly ToolchainEntry[]) =>
  entries.reduce((sum, entry) => sum + (entry.local && isBundled(entry) ? entry.local.bytes : 0), 0);

/** The nearest folder of `target` that exists (the store itself may not yet): where its free space is read. */
export async function nearestExisting(target: string): Promise<string> {
  let at = path.resolve(target);
  while (
    !(await stat(at).then(
      () => true,
      () => false,
    ))
  ) {
    const parent = path.dirname(at);
    if (parent === at) return at;
    at = parent;
  }
  return at;
}

async function assertDiskSpace(store: string, pending: readonly ToolchainEntry[], freeBytes: InstallDeps["freeBytes"]) {
  const needed = unpackedBytes(archiveBytes(pending)) + bundledBytes(pending) + DISK_RESERVE_BYTES;
  const free = await freeBytes(await nearestExisting(store));
  if (free < needed) throw new ToolchainError(ToolchainProblem.DiskSpace, MESSAGE.NoSpace(needed, free));
}

// ---------- download ----------

function scheduleTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * `pending`'s value, unless nothing arrives for {@link STALL_TIMEOUT_MS} on the injected timer (a
 * typed download failure) or the job is cancelled first (its abort reason).
 */
function beforeStall<T>(pending: Promise<T>, url: string, deps: InstallDeps): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { signal } = deps;
    let cancelTimer = () => {};
    const onAbort = () => {
      cancelTimer();
      reject(signal?.reason);
    };
    const settle = () => {
      cancelTimer();
      signal?.removeEventListener("abort", onAbort);
    };
    pending.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    cancelTimer = (deps.schedule ?? scheduleTimer)(() => {
      settle();
      reject(new ToolchainError(ToolchainProblem.Download, MESSAGE.Stalled(url)));
    }, STALL_TIMEOUT_MS);
  });
}

/** Streams `body` into a new `file`, each chunk before the stall timeout, stopping past the pinned size. */
async function writeBody(
  body: ReadableStream<Uint8Array>,
  archive: ToolchainArchive,
  file: string,
  deps: InstallDeps,
  progress: JobTracker,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = body.getReader();
  const next = () => beforeStall(reader.read(), archive.url, deps);
  const handle = await open(file, "wx");
  try {
    for (let chunk = await next(); !chunk.done; chunk = await next()) {
      deps.signal?.throwIfAborted();
      bytes += chunk.value.length;
      if (bytes > archive.bytes) break;
      hash.update(chunk.value);
      await handle.write(chunk.value);
      progress.advance(chunk.value.length);
    }
  } finally {
    await handle.close();
    await reader.cancel().catch(() => {});
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Streams one archive into `file` through the injected fetch, then checks its pinned size and sha256. */
async function downloadArchive(
  archive: ToolchainArchive,
  file: string,
  deps: InstallDeps,
  progress: JobTracker,
): Promise<void> {
  // Ends the request (headers or body) whenever the download stops, stalled or failed.
  const ended = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, ended.signal]) : ended.signal;
  let written: { bytes: number; sha256: string };
  try {
    const response = await beforeStall(deps.fetch(archive.url, { signal }), archive.url, deps);
    if (!response.ok || !response.body)
      throw new ToolchainError(ToolchainProblem.Download, MESSAGE.HttpFailed(response.status, archive.url));
    written = await writeBody(response.body, archive, file, deps, progress);
  } catch (error) {
    deps.signal?.throwIfAborted();
    if (error instanceof ToolchainError) throw error;
    throw new ToolchainError(ToolchainProblem.Download, MESSAGE.Unreachable(archive.url, String(error)));
  } finally {
    ended.abort();
  }
  progress.phase(ToolchainInstallPhase.Verifying, progress.entry());
  if (written.bytes !== archive.bytes || written.sha256 !== archive.sha256) {
    await rm(file, { force: true });
    throw new ToolchainError(ToolchainProblem.Integrity, MESSAGE.Integrity(archive.url));
  }
}

/**
 * The verified file to extract `archive` from: the shared download cache's entry when the install
 * has one (downloaded into it first when missing), else a fresh download at `file`.
 */
async function fetchArchive(
  archive: ToolchainArchive,
  file: string,
  deps: InstallDeps,
  progress: JobTracker,
): Promise<string> {
  if (!deps.downloadCache) {
    await downloadArchive(archive, file, deps, progress);
    return file;
  }
  const cached = await cachedDownload(deps.downloadCache, archive, (into) =>
    downloadArchive(archive, into, deps, progress),
  );
  if (cached.hit) progress.advance(archive.bytes);
  return cached.file;
}

// ---------- probe ----------

/** A version probe (`exact`: its whole output, trimmed, must be the version) or the files a component must hold. */
type VersionProbe = { bin: string; args: readonly string[]; expect: string | null; exact?: boolean };
type ProbeSpec = VersionProbe | { files: readonly string[] };

const runProbe = (bin: string, args: readonly string[], expect: string | null, exact = false): ProbeSpec => ({
  bin,
  args,
  expect,
  exact,
});
const exe = (host: ToolchainHost, name: string) => (host === ToolchainHost.WindowsX64 ? `${name}.exe` : name);

/** What proves each component installed: a version it prints, or the files it must hold. */
const PROBES = {
  [ToolchainId.Cmake]: (entry, host) => [runProbe(COMPONENT_LAYOUT.cmake[host], ["--version"], entry.version)],
  [ToolchainId.Ninja]: (entry, host) => [runProbe(COMPONENT_LAYOUT.ninja[host], ["--version"], entry.version)],
  [ToolchainId.Emsdk]: (_entry, host) => [
    runProbe(COMPONENT_LAYOUT.python[host], ["--version"], EMSDK_BUNDLED.python),
    runProbe(COMPONENT_LAYOUT.node[host], ["--version"], EMSDK_BUNDLED.node),
  ],
  // `zig version` prints the version alone; a dev build's `0.16.0-dev.N+hash` is not the pin.
  [ToolchainId.Zig]: (entry, host) => [runProbe(COMPONENT_LAYOUT.zig[host], ["version"], entry.version, true)],
  [ToolchainId.LlvmMingw]: (_entry, host) => [runProbe(exe(host, "bin/clang"), ["--version"], null)],
  [ToolchainId.RaylibSource]: () => [{ files: ["CMakeLists.txt", "src/raylib.h"] }],
  [ToolchainId.AngleMac]: () => [{ files: ["libEGL.dylib", "libGLESv2.dylib"] }],
  [ToolchainId.AngleWindows]: () => [{ files: ["libEGL.dll", "libGLESv2.dll"] }],
  [ToolchainId.AngleLinux]: () => [{ files: ["libEGL.so", "libGLESv2.so"] }],
  // A local artifact: its manifest pins every file; these are the ones GLFW cannot compile without.
  [ToolchainId.LinuxSysroot]: () => [
    { files: ["usr/include/X11/Xlib.h", "usr/include/wayland-client.h", "glfw-wayland/xdg-shell-client-protocol.h"] },
  ],
  // The Rust dist tarballs unpack one component per folder (`RUST_COMPONENT_LAYOUT`): each holds
  // its own `manifest.in`, so they cannot share one root; the sysroot is assembled from them (M2.3).
  [ToolchainId.Rust]: (entry, host) => [
    runProbe(exe(host, RUST_COMPONENT_LAYOUT.rustc), ["--version"], entry.version),
    runProbe(exe(host, RUST_COMPONENT_LAYOUT.cargo), ["--version"], entry.version),
    { files: [RUST_COMPONENT_LAYOUT.hostStd] },
  ],
  [ToolchainId.RustStdWasm]: () => [{ files: [RUST_COMPONENT_LAYOUT.wasmStd] }],
  [ToolchainId.WasmBindgen]: (entry, host) => [
    runProbe(exe(host, RUST_COMPONENT_LAYOUT.wasmBindgen), ["--version"], `wasm-bindgen ${entry.version}`),
  ],
  [ToolchainId.Binaryen]: (entry, host) => [
    runProbe(exe(host, RUST_COMPONENT_LAYOUT.wasmOpt), ["--version"], `version ${entry.version}`),
  ],
  // The vendored crate set's archive is the cut genex release (`rust-release.ts`, M2.18): one `vendor/` folder.
  [ToolchainId.RustVendor]: () => [{ files: ["vendor"] }],
  // The cross destinations' standard libraries unpack at their component's root, as the browser's
  // does; their lanes pin them (M4.1, M4.2).
  [ToolchainId.RustStdWindows]: () => [{ files: ["lib/rustlib/x86_64-pc-windows-gnullvm/lib"] }],
  [ToolchainId.RustStdLinux]: () => [{ files: ["lib/rustlib/x86_64-unknown-linux-gnu/lib"] }],
  [ToolchainId.CargoZigbuild]: (entry, host) => [
    runProbe(exe(host, "cargo-zigbuild"), ["--version"], `cargo-zigbuild ${entry.version}`),
  ],
  [ToolchainId.SwiftShaderLinux]: () => [{ files: Object.values(LinuxVulkanFile) }],
  // The person's own Android install, which the store never unpacks: the files that prove a found
  // folder is the pinned one's kind (`android-sdk.ts` locates and probes the install itself).
  [ToolchainId.AndroidSdk]: () => [{ files: [`platforms/${ANDROID_PINS.platform}/android.jar`] }],
  [ToolchainId.AndroidBuildTools]: () => [{ files: ["aapt2", "zipalign", "apksigner", "d8"] }],
  [ToolchainId.AndroidNdk]: () => [{ files: ["source.properties", "toolchains/llvm/prebuilt"] }],
  [ToolchainId.Bundletool]: () => [{ files: ["bundletool.jar"] }],
  // The JDK's home unpacks at the component's root (a Mac archive's `Contents/Home` stripped, M5.4).
  [ToolchainId.Jdk]: (_entry, host) => [{ files: [exe(host, "bin/java")] }],
  [ToolchainId.RustStdIos]: () => [{ files: ["lib/rustlib/aarch64-apple-ios/lib"] }],
  [ToolchainId.RustStdIosSim]: () => [{ files: ["lib/rustlib/aarch64-apple-ios-sim/lib"] }],
  [ToolchainId.RustStdAndroid]: () => [{ files: ["lib/rustlib/aarch64-linux-android/lib"] }],
  // The crate checker (crate requests): each release archive unpacks its one program at the root.
  [ToolchainId.CargoDeny]: (entry, host) => [
    runProbe(exe(host, "cargo-deny"), ["--version"], `cargo-deny ${entry.version}`),
  ],
  [ToolchainId.CargoVet]: (entry, host) => [
    runProbe(exe(host, "cargo-vet"), ["--version"], `cargo-vet ${entry.version}`),
  ],
  [ToolchainId.RustsecAdvisoryDb]: () => [{ files: ["crates", "support.toml"] }],
} as const satisfies Record<ToolchainId, (entry: ToolchainEntry, host: ToolchainHost) => ProbeSpec[]>;

/** Every file a probe names is in the staging folder. */
async function checkFiles(entry: ToolchainEntry, staging: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const present = await stat(path.join(staging, ...file.split("/"))).then(
      () => true,
      () => false,
    );
    if (!present) throw new ToolchainError(ToolchainProblem.Probe, MESSAGE.ProbeMissing(entry.id, file));
  }
}

/** Whether a probe's output names its version: as all of it (trimmed) for an exact probe, else anywhere in it. */
function printedVersion(stdout: string, spec: VersionProbe): boolean {
  if (spec.expect === null) return true;
  return spec.exact ? stdout.trim() === spec.expect : stdout.includes(spec.expect);
}

/** Runs one version probe under the injected sandbox `run`; it must exit 0 and print what it expects. */
async function runVersionProbe(
  entry: ToolchainEntry,
  staging: string,
  spec: VersionProbe,
  deps: InstallDeps,
): Promise<void> {
  const command = [shellQuote(path.join(staging, ...spec.bin.split("/"))), ...spec.args].join(" ");
  const result = await deps.run({
    command,
    cwd: staging,
    timeoutMs: PROBE_TIMEOUT_MS,
    label: `toolchain-probe:${entry.id}`,
    signal: deps.signal,
  });
  deps.signal?.throwIfAborted();
  const printed = printedVersion(result.stdout, spec);
  if (result.code !== 0 || !printed)
    throw new ToolchainError(
      ToolchainProblem.Probe,
      MESSAGE.ProbeFailed(entry.id, (result.stderr || result.stdout).trim()),
    );
}

/** The files each probe of `entry` names are in its staging folder; nothing is run. */
async function probeFiles(entry: ToolchainEntry, staging: string): Promise<void> {
  const host = entry.host ?? ToolchainHost.MacArm64;
  for (const spec of PROBES[entry.id](entry, host)) if ("files" in spec) await checkFiles(entry, staging, spec.files);
}

/** Runs each probe of `entry` in its staging folder. */
async function probe(entry: ToolchainEntry, staging: string, deps: InstallDeps): Promise<void> {
  const host = entry.host ?? ToolchainHost.MacArm64;
  for (const spec of PROBES[entry.id](entry, host)) {
    if ("files" in spec) await checkFiles(entry, staging, spec.files);
    else await runVersionProbe(entry, staging, spec, deps);
  }
}

// ---------- stage and swap ----------

/** One folder a job swapped in, and whether it made the id folder above it. */
interface Swapped {
  folder: string;
  madeParent: boolean;
}

async function swapIn(
  store: string,
  id: ToolchainId,
  pin: { version: string; sha12: string },
  staging: string,
): Promise<Swapped> {
  const folder = componentFolder(store, id, pin);
  const parent = path.dirname(folder);
  const madeParent = !(await stat(parent).then(
    () => true,
    () => false,
  ));
  await mkdir(parent, { recursive: true });
  // A folder here has no matching receipt (isInstalled said so): it is not an install.
  await rm(folder, { recursive: true, force: true });
  await rename(staging, folder);
  return { folder, madeParent };
}

async function rollback(swapped: readonly Swapped[]): Promise<void> {
  for (const { folder, madeParent } of [...swapped].reverse()) {
    await rm(folder, { recursive: true, force: true });
    if (madeParent) await rmdir(path.dirname(folder)).catch(() => {});
  }
}

/** Removes `.staging` when nothing else is in it, so a failed job leaves the store as it was. */
export async function removeEmptyStaging(store: string): Promise<void> {
  await rmdir(path.join(store, STAGING_FOLDER)).catch(() => {});
}

async function writeReceipt(folder: string, receipt: ToolchainReceipt): Promise<void> {
  const handle = await open(path.join(folder, RECEIPT_FILE), "wx", 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

/** Downloads, extracts and probes one entry in staging, then swaps it in. */
async function installOne(
  store: string,
  entry: ToolchainEntry,
  deps: InstallDeps,
  progress: JobTracker,
): Promise<Swapped> {
  const sha12 = entrySha12(entry);
  const staging = path.join(store, STAGING_FOLDER, `${entry.id}-${sha12}`);
  const downloads = `${staging}.download`;
  await rm(staging, { recursive: true, force: true });
  await rm(downloads, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await mkdir(downloads, { recursive: true });
  try {
    const archives = installArchives(entry);
    const files: string[] = [];
    for (const [index, archive] of archives.entries()) {
      progress.phase(ToolchainInstallPhase.Downloading, entry.id);
      files.push(await fetchArchive(archive, path.join(downloads, `archive-${index}`), deps, progress));
    }
    progress.phase(ToolchainInstallPhase.Extracting, entry.id);
    for (const [index, archive] of archives.entries())
      await extractArchive(files[index] ?? "", archive.format, staging, {
        strip: archive.strip,
        into: archive.into,
        signal: deps.signal,
      });
    await rm(downloads, { recursive: true, force: true });
    progress.phase(ToolchainInstallPhase.Probing, entry.id);
    if (entry.local) {
      const manifest = await readPinnedManifest(staging, entry.local);
      assertExactly(await plainFiles(staging), manifest.files, []);
      for (const file of manifest.files) {
        const check = await readFile(path.join(staging, ...file.rel.split("/")));
        if (check.length !== file.size || createHash("sha256").update(check).digest("hex") !== file.sha256) {
          throw new ToolchainError(ToolchainProblem.Integrity, `The sysroot file ${file.rel} differs from its pin.`);
        }
      }
    }
    await probe(entry, staging, deps);
    await writeReceipt(staging, {
      id: entry.id,
      version: entry.version,
      sha256: entryDigest(entry),
      sha12,
      bytes: archiveBytes([entry]),
      host: entry.host,
      target: entry.target,
      source: ReceiptSource.Archive,
      installedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    });
    return await swapIn(store, entry.id, { version: entry.version, sha12 }, staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(downloads, { recursive: true, force: true });
  }
}

/**
 * Installs one pending entry of a job: a component the app bundles is copied from its resources
 * (the core's, or {@link appResourcesDir}), anything else downloaded. Null when nothing was added.
 */
async function installEntry(
  store: string,
  entry: ToolchainEntry,
  deps: InstallDeps,
  progress: JobTracker,
): Promise<Swapped | null> {
  if (!isBundled(entry)) return installOne(store, entry, deps, progress);
  progress.phase(ToolchainInstallPhase.Extracting, entry.id);
  return installBundled(store, entry, deps.resources ?? appResourcesDir(), { now: deps.now });
}

/** Installs `entries` into `store`, reporting each phase through `onJob`; answers the finished job. */
export async function installComponents(
  store: string,
  entries: readonly ToolchainEntry[],
  deps: InstallDeps,
): Promise<ToolchainInstallJob> {
  const progress = jobTracker(deps.onJob, deps.now ?? Date.now);
  const swapped: Swapped[] = [];
  try {
    progress.phase(ToolchainInstallPhase.Preflight, null);
    for (const entry of entries) assertInstallable(entry);
    const pending: ToolchainEntry[] = [];
    for (const entry of entries) if (!(await isInstalled(store, entry))) pending.push(entry);
    progress.total(archiveBytes(pending));
    if (pending.length) await assertDiskSpace(store, pending, deps.freeBytes);
    for (const entry of pending) {
      const done = await installEntry(store, entry, deps, progress);
      if (done) swapped.push(done);
    }
    await removeEmptyStaging(store);
    return progress.finish(ToolchainInstallPhase.Installed);
  } catch (error) {
    await rollback(swapped);
    await removeEmptyStaging(store);
    if (deps.signal?.aborted) return progress.finish(ToolchainInstallPhase.Cancelled);
    if (error instanceof ToolchainError) return progress.finish(ToolchainInstallPhase.Failed, error.problem);
    progress.finish(ToolchainInstallPhase.Failed);
    throw error;
  }
}

// ---------- pinned artifacts: bundled with the app, or the developer's local folder ----------

/** The file a pinned artifact's folder is pinned by: every other file's path, size and sha256. */
export const LOCAL_MANIFEST_FILE = ARTIFACT_MANIFEST_FILE;

/** How one verified copy of an artifact folder is made. */
interface VerifiedCopy {
  source: ReceiptSource;
  /** What the manifest must name (a bundled build's ANGLE commit and build target), or null. */
  origin: { commit: string; target: string } | null;
  /** Whether the folder may hold `signatures.json` (the app's own copy, which its signing may re-sign). */
  signed: boolean;
  now: () => number;
}

/** The folder `entry` is installed into, after checking its pin can name one. */
function pinnedFolder(
  store: string,
  entry: ToolchainEntry,
): { pin: { version: string; sha12: string }; final: string } {
  const sha12 = entrySha12(entry);
  const pin = { version: entry.version, sha12 };
  if (!isSafePin(pin)) throw new ToolchainError(ToolchainProblem.Archive, MESSAGE.BadPin(entry.version, sha12));
  return { pin, final: componentFolder(store, entry.id, pin) };
}

/** Whether the store already holds `entry` at its pinned artifact digest. */
async function holdsArtifact(final: string, entry: ToolchainEntry, local: ToolchainLocalArtifact): Promise<boolean> {
  const existing = await readReceipt(final);
  return existing?.id === entry.id && existing.sha256 === local.manifestSha256;
}

/** The pinned artifact folder's realpath, refused when it is a link (it must be the folder itself). */
async function artifactRoot(folder: string): Promise<string> {
  const root = await realpath(folder);
  if ((await lstat(folder)).isSymbolicLink())
    throw new ArtifactError(ArtifactFault.NotRegular, MESSAGE.NotRegular(path.basename(folder)));
  return root;
}

/**
 * Verifies `folder` against `entry`'s pinned `manifest.json` and copies it into staging, file by
 * file (each copy held to its listed size and sha256, a re-signed library restored first), with
 * the manifest and a receipt, then swaps it in. A refused folder leaves the store as it was.
 */
async function stageVerifiedCopy(
  store: string,
  entry: ToolchainEntry,
  local: ToolchainLocalArtifact,
  folder: string,
  how: VerifiedCopy,
): Promise<Swapped> {
  const { pin } = pinnedFolder(store, entry);
  const root = await artifactRoot(folder);
  const manifest = await readPinnedManifest(root, local);
  if (how.origin) assertOrigin(manifest, how.origin);
  const signatures = how.signed ? await readSignatures(root) : new Map<string, SignatureRecord>();
  assertExactly(await plainFiles(root), manifest.files, how.signed ? [SIGNATURES_FILE] : []);
  const staging = path.join(store, STAGING_FOLDER, `${entry.id}-${pin.sha12}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const file of manifest.files) await copyListed(root, staging, file, signatures.get(file.rel) ?? null);
    await writeNew(path.join(staging, LOCAL_MANIFEST_FILE), manifest.bytes);
    await probeFiles(entry, staging);
    await writeReceipt(staging, {
      id: entry.id,
      version: entry.version,
      sha256: local.manifestSha256,
      sha12: pin.sha12,
      bytes: local.bytes,
      host: entry.host,
      target: entry.target,
      source: how.source,
      installedAt: new Date(how.now()).toISOString(),
    });
    return await swapIn(store, entry.id, pin, staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await removeEmptyStaging(store);
  }
}

/**
 * The developer's store only: installs a local artifact (`entry.local`, ANGLE) from `folder`, a
 * folder Genex built whose `manifest.json` is the pinned one (size and sha256) and lists every
 * other file's size and sha256. A link, a FIFO or any other special file, a file the manifest
 * does not list, a listed one that is missing or differs, and a manifest path that is absolute or
 * climbs out are refused (typed: `ArtifactError`), and the store is left as it was. The files are
 * copied (never linked) with the manifest into `<store>/<id>/<version>-<sha12>/` beside a
 * `local-artifact` receipt. Answers the install folder; one already there at its pin is kept as it is.
 */
export async function installLocalArtifact(
  store: string,
  entry: ToolchainEntry,
  folder: string,
  options: { now?: () => number } = {},
): Promise<string> {
  const { local } = entry;
  if (!local) throw new ToolchainError(ToolchainProblem.Unpinned, MESSAGE.NotLocal(entry.id));
  const { final } = pinnedFolder(store, entry);
  if (await holdsArtifact(final, entry, local)) return final;
  const how = { source: ReceiptSource.LocalArtifact, origin: null, signed: false, now: options.now ?? Date.now };
  return (await stageVerifiedCopy(store, entry, local, folder, how)).folder;
}

/**
 * Copies one bundled entry from the app's resources into staging and swaps it in; null when the
 * store already holds it at its pin (nothing was added, so nothing is rolled back).
 */
async function installBundled(
  store: string,
  entry: ToolchainEntry,
  resources: string,
  options: { now?: () => number; lock?: BundleLock },
): Promise<Swapped | null> {
  if (isBundledLinuxSysroot(entry)) return installBundledLinuxSysroot(store, entry, resources, options);
  const lock = options.lock ?? BUNDLE_LOCK;
  const target = bundledTargetOf(entry, lock);
  const { local } = entry;
  if (!target || !local) throw new ToolchainError(ToolchainProblem.NotHosted, MESSAGE.NotHosted(entry.id));
  if (await holdsArtifact(pinnedFolder(store, entry).final, entry, local)) return null;
  const folder = bundledFolder(resources, target, lock);
  if (!(await lstat(folder).catch(() => null)))
    throw new ArtifactError(ArtifactFault.Missing, MESSAGE.NotBundled(entry.id, folder));
  const how = {
    source: ReceiptSource.Bundled,
    origin: { commit: lock.commit, target },
    signed: true,
    now: options.now ?? Date.now,
  };
  return stageVerifiedCopy(store, entry, local, folder, how);
}

/** Install the included Linux headers through the same file-by-file copy and receipt transaction. */
async function installBundledLinuxSysroot(
  store: string,
  entry: ToolchainEntry,
  resources: string,
  options: { now?: () => number },
): Promise<Swapped | null> {
  const { local } = entry;
  if (!local) throw new ToolchainError(ToolchainProblem.NotHosted, MESSAGE.NotHosted(entry.id));
  if (await holdsArtifact(pinnedFolder(store, entry).final, entry, local)) return null;
  const folder = bundledLinuxSysrootFolder(resources);
  await verifyLinuxSysrootFolder(folder);
  const how = { source: ReceiptSource.Bundled, origin: null, signed: false, now: options.now ?? Date.now };
  return stageVerifiedCopy(store, entry, local, folder, how);
}

/**
 * Installs a pinned ANGLE build or Linux headers from app resources, verified against its manifest
 * file by file and its source provenance. Re-signed Mac libraries are restored to pinned bytes
 * first. Copies into `<store>/<id>/<version>-<sha12>/` beside a `bundled` receipt; missing or altered
 * resources fail typed and leave the store unchanged. An artifact not included in this app is
 * `not-hosted`. Answers the install folder; one already there at its pin is kept.
 */
export async function installBundledArtifact(
  store: string,
  entry: ToolchainEntry,
  resources: string,
  options: { now?: () => number; lock?: BundleLock } = {},
): Promise<string> {
  const swapped = await installBundled(store, entry, resources, options);
  return swapped?.folder ?? pinnedFolder(store, entry).final;
}

// ---------- receipts and pruning ----------

/** Every receipt in the store; a folder without a readable receipt is not installed. */
export async function readReceipts(store: string): Promise<ToolchainReceipt[]> {
  const receipts: ToolchainReceipt[] = [];
  for (const id of Object.values(ToolchainId)) {
    for (const name of await listDirs(path.join(store, id))) {
      const receipt = await readReceipt(path.join(store, id, name));
      if (receipt?.id === id && `${receipt.version}-${receipt.sha12}` === name) receipts.push(receipt);
    }
  }
  return receipts;
}

/** Bytes under `target`, links counted as themselves. */
export async function treeBytes(target: string): Promise<number> {
  const info = await lstat(target).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(target)) total += await treeBytes(path.join(target, name));
  return total;
}

/** Removes every install folder and lock folder `keep` does not name (store-relative `<id>/<version>-<sha12>`, `locks/<digest12>`). */
export async function pruneStore(
  store: string,
  keep: ReadonlySet<string>,
): Promise<{ removed: number; bytes: number }> {
  const candidates: string[] = [];
  for (const folder of [...Object.values(ToolchainId), LOCKS_FOLDER])
    for (const name of await listDirs(path.join(store, folder))) candidates.push(`${folder}/${name}`);
  let removed = 0;
  let bytes = 0;
  for (const rel of candidates) {
    if (keep.has(rel)) continue;
    const full = path.join(store, ...rel.split("/"));
    bytes += await treeBytes(full);
    await rm(full, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, bytes };
}
