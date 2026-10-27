/**
 * The Rust · wgpu payload beyond what `install.ts` unpacks: the vendored crate tree held to its
 * pinned tree digest, and the lock's base, one sysroot and one CARGO_HOME.
 *
 * - The vendored archive installs like any pinned archive (sha256 and size against the pin, the
 *   store's own reader), then its unpacked `vendor/` must have the pinned tree digest
 *   (`archive.ts` `treeDigest`), or the install is removed and refused `integrity`. The digest is
 *   kept beside the receipt (`vendor-tree.json`) and checked again before a base is assembled.
 *   The pin comes from the caller until the owner publishes a cut genex release
 *   (`scripts/toolchains/rust-release.ts`, M2.18) and its `rust-vendor` entry is pinned.
 * - The dist tarballs unpack one folder per part (`RUST_PARTS`), each with its own `manifest.in`,
 *   so rustc would find no standard library beside it. The base merges the parts and each
 *   standard-library component the lock names (the browser's, the cross destinations' and the
 *   phones') into `locks/<digest12>/sysroot`, hard-linking the
 *   installed files (the bytes are shared, the store is write-denied to every sandbox) and
 *   refusing a link, a special file or two parts that disagree about one file.
 * - It is assembled in `.staging/`, probed there under the injected sandbox `run` with the network
 *   off and only staging writable (`rustc --version`, `cargo --version`, `rustc --print sysroot`
 *   must be the staged sysroot, and each named standard library's target-libdir must be in it), then swapped in;
 *   `rust-base.json` is written last, so a base without it is no base.
 */
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { BuildTarget } from "../../shared/game-project.ts";
import {
  type ToolchainEntry,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  type ToolchainInstallJob,
  ToolchainInstallPhase,
  type ToolchainLock,
  ToolchainProblem,
} from "../../shared/toolchain.ts";
import { atomicWriteJson, isJsonObject } from "../fsx.ts";
import { type RunRequest, type RunResult, shellQuote } from "../spawn.ts";
import { type TreeDigest, treeDigest } from "./archive.ts";
import { type InstallDeps, installComponents, removeEmptyStaging, STAGING_FOLDER } from "./install.ts";
import { componentFolder, type InstalledComponent, locateComponents, lockFolder, RECEIPT_FILE } from "./locate.ts";
import { isToolchainLock } from "./lock.ts";
import { entrySha12 } from "./manifest.ts";
import {
  RUST_BASE_FILE,
  RUST_HOST_TRIPLE,
  RUST_TRIPLE,
  RUST_VENDOR_LAYOUT,
  type RustBaseRecord,
  RustStoreFolder,
  rustCargoConfig,
  rustPartFolders,
} from "./rust-locate.ts";
import { rustPrewarmPolicy } from "./rust-prewarm.ts";

const MESSAGE = {
  NotVendor: (id: string) => `${id} is not the vendored crate set.`,
  TreeMismatch: (files: number, bytes: number) =>
    `The vendored crate tree (${files} files, ${bytes} bytes) does not match its pinned tree digest.`,
  NoTreePin: "The vendored crate tree has no recorded tree digest; reinstall it.",
  NotRegular: (rel: string) => `${rel} in a Rust part is a link or a special file; the sysroot holds only files.`,
  Conflict: (rel: string) => `Two Rust parts disagree about ${rel}.`,
  NoStore: (store: string) => `The toolchain store ${store} does not exist.`,
  BadLock: "The lock is malformed, or its digest is not its entries'.",
  Missing: (ids: readonly string[]) => `The store is missing ${ids.join(", ")} for this lock.`,
  ProbeFailed: (what: string, detail: string) => `The assembled Rust sysroot failed its probe (${what}): ${detail}`,
} as const;

/** Beside the vendored set's receipt: the tree digest its install was held to. */
export const VENDOR_TREE_FILE = "vendor-tree.json";

/** The label of the sandbox runs that probe an assembled sysroot. */
export const RustBaseStep = {
  Probe: "rust-base:probe",
} as const;
export type RustBaseStep = (typeof RustBaseStep)[keyof typeof RustBaseStep];

/** A version probe of a pinned tool: never an unbounded wait. */
const PROBE_TIMEOUT_MS = 30 * SECOND_MS;
const PROBE_DETAIL_MAX_CHARS = 500;
/** What each dist part carries for the rust installer, never part of a sysroot. */
const PART_MANIFEST = "manifest.in";
const BASE_STAGING_SUFFIX = "-rust-base";
const TMP_FOLDER = ".tmp";

// ---------- the vendored crate tree ----------

const sameTree = (a: TreeDigest, b: TreeDigest) => a.sha256 === b.sha256 && a.files === b.files && a.bytes === b.bytes;

/** Holds `folder`'s installed `vendor/` to `pin`; a mismatch throws `integrity`. */
export async function verifyVendorTree(folder: string, pin: TreeDigest): Promise<TreeDigest> {
  const found = await treeDigest(path.join(folder, RUST_VENDOR_LAYOUT));
  if (!sameTree(found, pin))
    throw new ToolchainError(ToolchainProblem.Integrity, MESSAGE.TreeMismatch(found.files, found.bytes));
  return found;
}

/** The tree digest recorded beside an installed vendored set, or null. */
async function recordedTree(folder: string): Promise<TreeDigest | null> {
  const value = await readFile(path.join(folder, VENDOR_TREE_FILE), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const shaped =
    isJsonObject(value) &&
    typeof value.sha256 === "string" &&
    Number.isSafeInteger(value.files) &&
    Number.isSafeInteger(value.bytes);
  return shaped ? { sha256: String(value.sha256), files: Number(value.files), bytes: Number(value.bytes) } : null;
}

/** Removes a refused install folder, and its id folder when that is left empty. */
async function removeInstall(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true });
  await rmdir(path.dirname(folder)).catch(() => {});
}

/**
 * Installs the vendored crate set `entry` (its archive verified as every pinned archive is), then
 * holds the unpacked tree to `pin`: a mismatch removes the install and finishes the job `failed`
 * with `integrity`. On success the digest is kept beside the receipt.
 */
export async function installRustVendor(
  store: string,
  entry: ToolchainEntry,
  pin: TreeDigest,
  deps: InstallDeps,
): Promise<ToolchainInstallJob> {
  if (entry.id !== ToolchainId.RustVendor)
    throw new ToolchainError(ToolchainProblem.Unpinned, MESSAGE.NotVendor(entry.id));
  const job = await installComponents(store, [entry], deps);
  if (job.phase !== ToolchainInstallPhase.Installed) return job;
  const folder = componentFolder(store, entry.id, { version: entry.version, sha12: entrySha12(entry) });
  try {
    await verifyVendorTree(folder, pin);
  } catch (error) {
    if (!(error instanceof ToolchainError)) throw error;
    await removeInstall(folder);
    const failed: ToolchainInstallJob = { ...job, phase: ToolchainInstallPhase.Failed, problem: error.problem };
    deps.onJob(failed);
    return failed;
  }
  await atomicWriteJson(path.join(folder, VENDOR_TREE_FILE), pin);
  return job;
}

// ---------- the sysroot ----------

/** Whether two regular files hold the same bytes. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([lstat(a), lstat(b)]);
  if (!right.isFile() || left.size !== right.size) return false;
  const digest = async (file: string) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  return (await digest(a)) === (await digest(b));
}

/** Puts `from` at `to`: a hard link (shared bytes), or a clone where the two are on different volumes. */
async function share(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to, FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE);
  }
}

/**
 * Places one part file at `target` (`child` is its part-relative path): skipped when it is the
 * part's own manifest or the receipt, or when the same bytes are already there; refused when
 * other bytes are. Answers whether it placed the file.
 */
async function placeFile(source: string, target: string, child: string): Promise<boolean> {
  if (child === PART_MANIFEST || child === RECEIPT_FILE) return false;
  const existing = await lstat(target).catch(() => null);
  if (!existing) {
    await share(source, target);
    return true;
  }
  if (!(await sameBytes(source, target))) throw new ToolchainError(ToolchainProblem.Integrity, MESSAGE.Conflict(child));
  return false;
}

/** Merges one part's tree under `part` into `into`, `rel` deep; answers how many files it placed. */
async function mergePart(part: string, into: string, rel = ""): Promise<number> {
  let placed = 0;
  const at = rel ? path.join(part, ...rel.split("/")) : part;
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    const target = path.join(into, ...child.split("/"));
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      placed += await mergePart(part, into, child);
    } else if (entry.isFile()) {
      placed += Number(await placeFile(path.join(at, entry.name), target, child));
    } else throw new ToolchainError(ToolchainProblem.Integrity, MESSAGE.NotRegular(child));
  }
  return placed;
}

/**
 * Assembles one sysroot at `into` from the dist `parts` (each a folder as its tarball unpacked,
 * `manifest.in` left out), sharing the installed files' bytes. A link or a special file in a part,
 * or two parts holding different bytes at one path, refuses it (`integrity`).
 */
export async function assembleSysroot(parts: readonly string[], into: string): Promise<{ files: number }> {
  await mkdir(into, { recursive: true });
  let files = 0;
  for (const part of parts) files += await mergePart(part, into);
  return { files };
}

// ---------- the base ----------

/** What a base install is given: the sandbox, what it must never write, and the clock. */
export interface RustBaseDeps {
  run: (request: RunRequest) => Promise<RunResult>;
  /** Folders no probe may write besides the store's own: the games root, scratch and runs. */
  denyWrite: readonly string[];
  now?: () => number;
  signal?: AbortSignal;
}

/** Each destination standard library a lock may name, and the triple it holds. */
const STD_TRIPLES = {
  [ToolchainId.RustStdWasm]: RUST_TRIPLE[BuildTarget.Web],
  [ToolchainId.RustStdWindows]: RUST_TRIPLE[BuildTarget.Windows],
  [ToolchainId.RustStdLinux]: RUST_TRIPLE[BuildTarget.Linux],
  [ToolchainId.RustStdIos]: RUST_TRIPLE[BuildTarget.Ios],
  [ToolchainId.RustStdIosSim]: "aarch64-apple-ios-sim",
  [ToolchainId.RustStdAndroid]: RUST_TRIPLE[BuildTarget.Android],
} as const satisfies Partial<Record<ToolchainId, string>>;
type StdId = keyof typeof STD_TRIPLES;
const STD_IDS = Object.keys(STD_TRIPLES) as StdId[];

interface BaseParts {
  root: string;
  rust: InstalledComponent;
  /** The destination standard libraries the lock names, in {@link STD_TRIPLES}' order. */
  stds: Array<{ triple: string; component: InstalledComponent }>;
  vendor: InstalledComponent;
}

/** The store's real root and the installed components a base is assembled from, each checked. */
async function baseParts(store: string, lock: ToolchainLock): Promise<BaseParts> {
  const root = await realpath(store).catch(() => {
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoStore(store));
  });
  if (!isToolchainLock(lock)) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.BadLock);
  const named = STD_IDS.filter((id) => lock.entries[id] !== undefined);
  const ids = [ToolchainId.Rust, ToolchainId.RustVendor, ...named];
  const found = await locateComponents(root, lock, ids);
  if (!found.ok) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.Missing(found.missing));
  const rust = found.components.get(ToolchainId.Rust);
  const vendor = found.components.get(ToolchainId.RustVendor);
  if (!rust || !vendor) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.Missing(ids));
  const stds = named.flatMap((id) => {
    const component = found.components.get(id);
    return component ? [{ triple: STD_TRIPLES[id], component }] : [];
  });
  return { root, rust, vendor, stds };
}

/** The vendored set installed in `folder`, held again to the tree digest recorded at its install; `integrity` otherwise. */
export async function checkedVendorTree(folder: string): Promise<TreeDigest> {
  const pin = await recordedTree(folder);
  if (!pin) throw new ToolchainError(ToolchainProblem.Integrity, MESSAGE.NoTreePin);
  return verifyVendorTree(folder, pin);
}

/** The installed vendored tree, held again to the digest recorded at its install. */
async function checkedVendor(vendor: InstalledComponent): Promise<TreeDigest> {
  return checkedVendorTree(vendor.folder);
}

/** One probe run in staging under the sandbox; it must exit 0, and its trimmed stdout is answered. */
async function probe(
  staging: string,
  policyStore: string,
  argv: readonly string[],
  deps: RustBaseDeps,
): Promise<string> {
  const tmp = shellQuote(path.join(staging, TMP_FOLDER));
  const result = await deps.run({
    label: RustBaseStep.Probe,
    command: `export TMPDIR=${tmp} TMP=${tmp} TEMP=${tmp}; ${argv.map(shellQuote).join(" ")}`,
    cwd: staging,
    timeoutMs: PROBE_TIMEOUT_MS,
    policy: rustPrewarmPolicy(policyStore, staging, deps.denyWrite),
    signal: deps.signal,
  });
  deps.signal?.throwIfAborted();
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-PROBE_DETAIL_MAX_CHARS);
    throw new ToolchainError(ToolchainProblem.Probe, MESSAGE.ProbeFailed(argv.slice(1).join(" "), detail));
  }
  return result.stdout.trim();
}

/** Probes the staged sysroot: its rustc and cargo are the pinned version, and rustc finds itself and each named std there. */
async function probeBase(parts: BaseParts, staging: string, deps: RustBaseDeps): Promise<void> {
  const sysroot = path.join(staging, RustStoreFolder.Sysroot);
  const rustc = path.join(sysroot, "bin", "rustc");
  const cargo = path.join(sysroot, "bin", "cargo");
  const version = parts.rust.receipt.version;
  const expect = (what: string, ok: boolean, printed: string) => {
    if (!ok) throw new ToolchainError(ToolchainProblem.Probe, MESSAGE.ProbeFailed(what, printed));
  };
  const rustcVersion = await probe(staging, parts.root, [rustc, "--version"], deps);
  expect("rustc --version", rustcVersion.startsWith(`rustc ${version}`), rustcVersion);
  const cargoVersion = await probe(staging, parts.root, [cargo, "--version"], deps);
  expect("cargo --version", cargoVersion.startsWith(`cargo ${version}`), cargoVersion);
  const printed = await probe(staging, parts.root, [rustc, "--print", "sysroot"], deps);
  const real = await realpath(sysroot);
  expect("rustc --print sysroot", printed === real || printed === sysroot, printed);
  for (const { triple } of parts.stds) {
    const libdir = await probe(staging, parts.root, [rustc, "--print", "target-libdir", "--target", triple], deps);
    const inside = [real, sysroot].some((root) => libdir === path.join(root, "lib", "rustlib", triple, "lib"));
    expect(`rustc --print target-libdir --target ${triple}`, inside, libdir);
  }
}

/** Replaces the lock folder's sysroot and CARGO_HOME with the staged ones, the record written last. */
async function swapBase(root: string, lock: ToolchainLock, staging: string, record: RustBaseRecord): Promise<void> {
  const folder = lockFolder(root, lock);
  await mkdir(folder, { recursive: true });
  await rm(path.join(folder, RUST_BASE_FILE), { force: true });
  for (const name of [RustStoreFolder.Sysroot, RustStoreFolder.CargoHome]) {
    await rm(path.join(folder, name), { recursive: true, force: true });
    await rename(path.join(staging, name), path.join(folder, name));
  }
  await atomicWriteJson(path.join(folder, RUST_BASE_FILE), record);
}

/** The triples a base's sysroot holds a standard library for, the host's first. */
function baseTriples(parts: BaseParts): string[] {
  const host = RUST_HOST_TRIPLE[parts.rust.receipt.host ?? ToolchainHost.MacArm64];
  return [host, ...parts.stds.map(({ triple }) => triple).filter((triple) => triple !== host)];
}

/**
 * Installs `lock`'s base into its lock folder: the sysroot from the `rust` parts and the lock's
 * standard libraries, and a CARGO_HOME naming the vendored tree (held again to its digest),
 * probed under the sandbox, then swapped in. A refusal leaves the lock folder as it was.
 */
export async function installRustBase(store: string, lock: ToolchainLock, deps: RustBaseDeps): Promise<RustBaseRecord> {
  const parts = await baseParts(store, lock);
  const vendorTree = await checkedVendor(parts.vendor);
  const staging = path.join(parts.root, STAGING_FOLDER, `${lock.digest}${BASE_STAGING_SUFFIX}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, TMP_FOLDER), { recursive: true });
  try {
    const sources = [...rustPartFolders(parts.rust.folder), ...parts.stds.map(({ component }) => component.folder)];
    await assembleSysroot(sources, path.join(staging, RustStoreFolder.Sysroot));
    const cargoHome = path.join(staging, RustStoreFolder.CargoHome);
    await mkdir(cargoHome);
    await writeFile(
      path.join(cargoHome, "config.toml"),
      rustCargoConfig(path.join(parts.vendor.folder, RUST_VENDOR_LAYOUT)),
    );
    await probeBase(parts, staging, deps);
    const record: RustBaseRecord = {
      schema: 1,
      lock: lock.digest,
      triples: baseTriples(parts),
      vendor: vendorTree,
      at: new Date((deps.now ?? Date.now)()).toISOString(),
    };
    await swapBase(parts.root, lock, staging, record);
    return record;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await removeEmptyStaging(parts.root);
  }
}
