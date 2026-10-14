/**
 * Cuts a `genex` release from the workspace (M2.18): the vendored crate set every Rust game builds
 * from offline, with this checkout's genex crates packaged into it, as one reproducible archive
 * named by a durable Genex release URL, and the Rust locks and release-manifest inputs it makes.
 * Publishing the archive is the owner's step; pinning it into the recipe follows the publication.
 *
 *   node scripts/toolchains/rust-release.ts bump <version>
 *   node scripts/toolchains/rust-release.ts inventory [--tree <dir>] [--inventory <file>]
 *   node scripts/toolchains/rust-release.ts cut --out <dir> [--tree <dir>] [--release-base <url>]
 *   node scripts/toolchains/rust-release.ts pin --from <dir> [--recipe <file>]
 *   node scripts/toolchains/rust-release.ts tree --out <dir>
 *
 * - `bump` moves the workspace version (`[workspace.package]`, the workspace's own path
 *   dependencies) and every workspace package of `Cargo.lock` at it; a registry crate never moves.
 * - `tree` builds the release's vendored tree: the allowlist re-vendored offline through
 *   `rust-env.ts` (`cargo vendor --offline --locked --versioned-dirs` over the lock the installed
 *   tree was vendored from), plus the genex workspace's library crates as `cargo package` makes
 *   them from a copy of the workspace in the git-ignored scratch (so no crate records the commit
 *   and the tree does not move with HEAD), each unpacked with the `.cargo-checksum.json` a
 *   directory source needs.
 * - `inventory` rewrites `rust-inventory.json` from that tree, with its `release` (the genex
 *   version and the tree's digest): a release change a person reviews before committing.
 * - `cut` builds the tree again and refuses it unless it is exactly the reviewed one (the
 *   inventory's entries, its tree digest and its genex version, which must be the workspace's and
 *   its lock's), then writes into `--out`: `rust-vendor.tar.gz` (sorted, times and owners zeroed,
 *   so one tree packs into one byte stream), `release.json`, each recipe host's
 *   `locks/<host>/current-lock.rust-wgpu.json` and `release-manifest-inputs.json`. Every refusal
 *   comes before anything is written; the folder is filled beside its name and renamed into place.
 * - `pin` writes the cut's `rust-vendor` entry into `rust-recipe.json` once the owner published it.
 *
 * Dev and test builds before a publication resolve genex from the workspace ({@link resolveGenex};
 * the dev store packages it, `dev-store.ts --stack rust-wgpu`).
 *
 * A refusal is one line on stderr, `genex-rust-release-refusal: {"code":…,"detail":…}`, and exit 78.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GameStack } from "../../src/shared/game-project.ts";
import {
  LOCK_FILE_OF_STACK,
  type ToolchainEntry,
  ToolchainId,
  type ToolchainLock,
} from "../../src/shared/toolchain.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../src/substrate/fsx.ts";
import { type TreeDigest, treeDigest } from "../../src/substrate/toolchain-store/archive.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { entrySha12, isReleaseUrl, rustManifestOf } from "../../src/substrate/toolchain-store/manifest.ts";
import { rustStoreInputs } from "../release-manifest.mjs";
import { RUST_ENV_REFUSAL_EXIT, rustToolchainLayout } from "./rust-env.ts";
import { type CrateEntry, checkVendor, packArchive, readInventory, scanVendor, VendorRefused } from "./rust-vendor.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const DEFAULT_INVENTORY = path.join(REPO, "scripts", "toolchains", "rust-inventory.json");
const DEFAULT_RECIPE = path.join(REPO, "src", "substrate", "toolchain-store", "rust-recipe.json");
const ALLOWLIST = path.join(REPO, "scripts", "spike", "rust-wgpu", "vendor-allowlist.toml");
/** Where the public repository's releases live: the only host a cut names (`manifest.ts` holds the store to it too). */
const GENEX_RELEASES = "https://github.com/genex-games/genex-desktop/releases/download/";
/** The release asset holding the vendored crate set. */
export const VENDOR_FILE = "rust-vendor.tar.gz";
/** The archive's root folder: what the store's `vendor/` layout unpacks (`RUST_VENDOR_LAYOUT`). */
const VENDOR_ROOT = "vendor";
const RECORD_FILE = "release.json";
const MANIFEST_INPUTS_FILE = "release-manifest-inputs.json";
const LOCKS_FOLDER = "locks";
const RUST_LOCK_FILE = LOCK_FILE_OF_STACK[GameStack.RustWgpu];
const RECORD_SCHEMA = 1;
const CARGO_CHECKSUM_FILE = ".cargo-checksum.json";
/** What `cargo package` adds when the package sits in a git work tree: the commit, so the tree would move with HEAD. */
const CARGO_VCS_INFO_FILE = ".cargo_vcs_info.json";
/** The workspace copy cargo packages from, inside the release scratch (ignored by git, so cargo records no commit). */
const PACKAGE_WORKSPACE = "genex-workspace";
/** Folders a workspace copy never takes: version control and build output. */
const UNCOPIED_FOLDERS: ReadonlySet<string> = new Set([".git", "target"]);
const PACKAGE_TARGET = "genex-release-package";
/** cargo's output for one command: the vendor and package runs list every crate. */
const CARGO_MAX_BUFFER = 64 * 1024 * 1024;
const SEMVER = /^\d+\.\d+\.\d+$/;
const REFUSAL_PREFIX = "genex-rust-release-refusal: ";
const VENDOR_LICENCE = "MIT (genex crates); each vendored crate's own licence, held to deny.toml's allowlist";
const INVENTORY_ABOUT =
  "Every build script, proc macro and non-source file (binary or executable) in the vendored crate set, by vendored folder, and the reviewed genex release (`release`: the genex version and the release tree's digest). Reviewed by a person; written by `node scripts/toolchains/rust-release.ts inventory` (`rust-vendor.ts check` holds the installed tree to `crates`; `rust-release.ts cut` holds the release tree to all of it).";

/** Why a cut refused. Wire values: CI and tests match them. */
export const ReleaseRefusal = {
  Usage: "usage",
  BadVersion: "release-bad-version",
  VersionMismatch: "release-version-mismatch",
  WorkspaceUnreadable: "release-workspace-unreadable",
  NoRelease: "release-inventory-unreviewed",
  TreeMismatch: "release-tree-mismatch",
  OffHostUrl: "release-url-off-host",
  OutNotEmpty: "release-out-not-empty",
  CargoFailed: "release-cargo-failed",
  CommitBound: "release-commit-bound",
  /** A local cut's `release.json` or archive is absent, a link, not a regular file or not a cut's shape. */
  CutUnreadable: "release-cut-unreadable",
  /** A local cut's archive is not the size and sha256 its record names, or the record disagrees with itself. */
  CutDigest: "release-cut-digest",
} as const;
export type ReleaseRefusal = (typeof ReleaseRefusal)[keyof typeof ReleaseRefusal];

/** Where a build finds genex: the published release the recipe pins, or this checkout's workspace. */
export const GenexSource = { Release: "release", Local: "local" } as const;
export type GenexSource = (typeof GenexSource)[keyof typeof GenexSource];

const MESSAGE = {
  Usage:
    "usage: rust-release.ts bump <version> | inventory [--tree <dir>] [--inventory <file>] | cut --out <dir> [--tree <dir>] [--release-base <url>] [--inventory <file>] | pin --from <dir> [--recipe <file>] | tree --out <dir>",
  BadVersion: (version: string) => `${version} is not a release version (major.minor.patch)`,
  NoWorkspaceVersion: (file: string) => `${file} has no [workspace.package] version`,
  Unreadable: (file: string, why: string) => `${file} cannot be read: ${why}`,
  BumpFrom: (from: string, found: string) => `the workspace is at ${found}, not ${from}: nothing is bumped`,
  LockBehind: (name: string, found: string, version: string) =>
    `Cargo.lock holds ${name} ${found}, the workspace is ${version}: relock before cutting`,
  ReviewedOther: (reviewed: string, version: string) =>
    `the inventory reviewed genex ${reviewed}, the workspace is ${version}: rewrite it with \`rust-release.ts inventory\` and review it`,
  NoRelease: (file: string) =>
    `${file} records no reviewed release tree: rewrite it with \`rust-release.ts inventory\` and review it`,
  TreeMismatch: (found: TreeDigest, reviewed: TreeDigest) =>
    `the vendored tree (${found.files} files, ${found.bytes} bytes, ${found.sha256.slice(0, 12)}) is not the reviewed one (${reviewed.files} files, ${reviewed.bytes} bytes, ${reviewed.sha256.slice(0, 12)})`,
  OffHost: (url: string) => `${url} is not a durable Genex release URL (${GENEX_RELEASES}<tag>/…)`,
  OutNotEmpty: (dir: string) => `${dir} already holds files: a cut fills an empty folder`,
  Cargo: (what: string, why: string) => `cargo ${what} through rust-env.ts failed: ${why}`,
  NoCrates: (dir: string) => `cargo package wrote no genex crates into ${dir}`,
  CutUnreadable: (what: string) => `${what} is not a local cut's (absent, a link, not a regular file or malformed)`,
  CutDigest: (what: string) => `the local cut's ${what} is not what its release.json records`,
  CommitBound: (name: string) =>
    `${name} records the commit it was packaged at (${CARGO_VCS_INFO_FILE}), so the release tree would change with every commit: package from a folder git ignores`,
} as const;

/** A refusal on its way to the one typed stderr line. */
export class ReleaseRefused extends Error {
  readonly code: ReleaseRefusal;
  constructor(code: ReleaseRefusal, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** The reviewed release an inventory records. */
export interface ReviewedRelease {
  genex: string;
  tree: TreeDigest;
}

/** The recipe entry a cut makes for the vendored crate set: a pinned archive plus its tree digest. */
export interface VendorRecipeEntry {
  id: typeof ToolchainId.RustVendor;
  version: string;
  host: null;
  target: null;
  licence: string;
  archives: Array<{ url: string; bytes: number; sha256: string; format: "tar.gz"; strip: 0; into: "" }>;
  /** The unpacked `vendor/` tree's digest, which the store holds an install to (`installRustVendor`). */
  tree: TreeDigest;
}

/** One component of a host's release lock, with where it downloads from. */
export interface LockComponent {
  id: ToolchainId;
  version: string;
  sha12: string;
  urls: string[];
  sha256s: string[];
}

/** What a cut made: everything the owner publishes and the recipe pins, with no path of the computer that cut it. */
export interface ReleaseRecord {
  schema: typeof RECORD_SCHEMA;
  genex: string;
  tag: string;
  vendor: { file: string; url: string; sha256: string; bytes: number; files: number; tree: TreeDigest };
  inventorySha256: string;
  workspaceLockSha256: string;
  recipeEntry: VendorRecipeEntry;
  /** Per recipe host: the lock a store holding every Rust component of this release makes current. */
  locks: Record<string, { lock: ToolchainLock; components: LockComponent[] }>;
}

/** What a cut is given: the built vendored tree, the workspace, the reviewed inventory and the recipe it joins. */
export interface CutOptions {
  tree: string;
  workspace: string;
  inventory: string;
  out: string;
  recipe: unknown;
  /** The release download prefix (default the public repository's); anything off that host is refused. */
  releaseBase?: string;
}

/** Where genex resolves for a build. */
export type GenexResolution =
  | { source: typeof GenexSource.Release; version: string; entry: ToolchainEntry }
  | { source: typeof GenexSource.Local; version: string; workspace: string };

const sha256Of = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new ReleaseRefused(ReleaseRefusal.WorkspaceUnreadable, MESSAGE.Unreadable(file, (error as Error).message));
  }
}

function assertSemver(version: string): void {
  if (!SEMVER.test(version)) throw new ReleaseRefused(ReleaseRefusal.BadVersion, MESSAGE.BadVersion(version));
}

// ---------- the workspace's version ----------

/** The lines of one `[table]` of a TOML text, with their indexes; empty when the table is absent. */
function tableLines(text: string, table: string): Array<{ at: number; line: string }> {
  const lines = text.split("\n");
  const found: Array<{ at: number; line: string }> = [];
  let inside = false;
  for (const [at, line] of lines.entries()) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) inside = header[1] === table;
    else if (inside) found.push({ at, line });
  }
  return found;
}

const VERSION_LINE = /^(\s*version\s*=\s*")([^"]*)(".*)$/;
/** A `[workspace.dependencies]` line naming a workspace crate by path: `name = { path = "…", version = "…" }`. */
const PATH_DEPENDENCY = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{(?=[^}]*\bpath\s*=)[^}]*\}/;
const DEPENDENCY_VERSION = /(\bversion\s*=\s*")([^"]*)(")/;

/** The `[workspace.package]` version of a workspace manifest's text. */
function manifestVersion(text: string, file: string): string {
  for (const { line } of tableLines(text, "workspace.package")) {
    const version = VERSION_LINE.exec(line)?.[2];
    if (version !== undefined) return version;
  }
  throw new ReleaseRefused(ReleaseRefusal.WorkspaceUnreadable, MESSAGE.NoWorkspaceVersion(file));
}

/** The names of the workspace's own crates its `[workspace.dependencies]` name by path. */
function pathCrates(text: string): string[] {
  return tableLines(text, "workspace.dependencies").flatMap(({ line }) => {
    const name = PATH_DEPENDENCY.exec(line)?.[1];
    return name === undefined ? [] : [name];
  });
}

/** One `[[package]]` of a cargo lock: its name, version and whether it comes from a registry or git. */
interface LockPackage {
  name: string;
  version: string;
  sourced: boolean;
}

/** The `[[package]]` blocks of a cargo lock, in order. */
function lockPackages(text: string): LockPackage[] {
  return text
    .split("[[package]]")
    .slice(1)
    .map((block) => ({
      name: /^name = "(.*)"$/m.exec(block)?.[1] ?? "",
      version: /^version = "(.*)"$/m.exec(block)?.[1] ?? "",
      sourced: /^source = /m.test(block),
    }));
}

/** The workspace's version (`[workspace.package]` of its `Cargo.toml`): what its genex crates are released as. */
export async function workspaceVersion(workspace: string): Promise<string> {
  const file = path.join(workspace, "Cargo.toml");
  return manifestVersion(await readText(file), file);
}

/** The workspace's version, after refusing a `Cargo.lock` whose workspace crates are at another one. */
async function checkedWorkspaceVersion(workspace: string): Promise<string> {
  const manifestFile = path.join(workspace, "Cargo.toml");
  const manifest = await readText(manifestFile);
  const version = manifestVersion(manifest, manifestFile);
  assertSemver(version);
  const locked = lockPackages(await readText(path.join(workspace, "Cargo.lock")));
  for (const name of pathCrates(manifest)) {
    const found = locked.find((pkg) => pkg.name === name && !pkg.sourced)?.version ?? "none";
    if (found !== version)
      throw new ReleaseRefused(ReleaseRefusal.VersionMismatch, MESSAGE.LockBehind(name, found, version));
  }
  return version;
}

/**
 * The workspace manifest and lock moved from `from` to `to`: `[workspace.package]`'s version, the
 * version of each path dependency in `[workspace.dependencies]`, and every lock package that comes
 * from no registry (a workspace member) at `from`. Refused when either is not a release version or
 * the workspace is not at `from`.
 */
export function bumpWorkspace(
  manifest: string,
  lock: string,
  from: string,
  to: string,
): { manifest: string; lock: string } {
  assertSemver(from);
  assertSemver(to);
  const found = manifestVersion(manifest, "Cargo.toml");
  if (found !== from) throw new ReleaseRefused(ReleaseRefusal.VersionMismatch, MESSAGE.BumpFrom(from, found));
  const lines = manifest.split("\n");
  for (const { at, line } of tableLines(manifest, "workspace.package"))
    if (VERSION_LINE.exec(line)?.[2] === from) lines[at] = line.replace(VERSION_LINE, `$1${to}$3`);
  for (const { at, line } of tableLines(manifest, "workspace.dependencies"))
    if (PATH_DEPENDENCY.test(line) && DEPENDENCY_VERSION.exec(line)?.[2] === from)
      lines[at] = line.replace(DEPENDENCY_VERSION, `$1${to}$3`);
  const blocks = lock.split("[[package]]").map((block, index) => {
    if (index === 0 || /^source = /m.test(block)) return block;
    return block.replace(new RegExp(`^version = "${from.replaceAll(".", "\\.")}"$`, "m"), `version = "${to}"`);
  });
  return { manifest: lines.join("\n"), lock: blocks.join("[[package]]") };
}

// ---------- the reviewed inventory ----------

const isTreeDigest = (value: unknown): value is TreeDigest =>
  isJsonObject(value) &&
  typeof value.sha256 === "string" &&
  Number.isSafeInteger(value.files) &&
  Number.isSafeInteger(value.bytes);

/** The release an inventory reviewed, or null when it records none. */
async function reviewedRelease(inventory: string): Promise<ReviewedRelease | null> {
  await readInventory(inventory);
  const value: unknown = JSON.parse(await readFile(inventory, "utf8"));
  const release = isJsonObject(value) ? value.release : null;
  if (!isJsonObject(release) || typeof release.genex !== "string" || !isTreeDigest(release.tree)) return null;
  return { genex: release.genex, tree: release.tree };
}

/**
 * Rewrites the inventory from the release's vendored `tree` (a release change a person reviews):
 * every crate's build script, proc macro and non-source file, and the release (the workspace's
 * genex version and the tree's digest) a cut is held to.
 */
export async function writeReleaseInventory(tree: string, workspace: string, inventory: string): Promise<void> {
  const crates: Record<string, CrateEntry> = await scanVendor(tree);
  const release: ReviewedRelease = { genex: await checkedWorkspaceVersion(workspace), tree: await treeDigest(tree) };
  await writeFile(inventory, `${JSON.stringify({ about: INVENTORY_ABOUT, crates, release }, null, 2)}\n`);
}

// ---------- the cut ----------

/** The download URL of a release asset: `<base>genex-<version>/<file>`, the public repository's by default. */
export function releaseAssetUrl(version: string, file: string, base = GENEX_RELEASES): string {
  return `${base.endsWith("/") ? base : `${base}/`}genex-${version}/${file}`;
}

function assertReleaseUrl(url: string): void {
  if (!isReleaseUrl(ToolchainId.RustVendor, url))
    throw new ReleaseRefused(ReleaseRefusal.OffHostUrl, MESSAGE.OffHost(url));
}

/** `recipe` (rust-recipe.json's shape) with `entry` as its one vendored crate set. */
function recipeWithVendor(recipe: unknown, entry: VendorRecipeEntry): Record<string, unknown> {
  const base = isJsonObject(recipe) ? recipe : {};
  const entries = Array.isArray(base.entries) ? base.entries : [];
  const others = entries.filter((item: unknown) => !isJsonObject(item) || item.id !== ToolchainId.RustVendor);
  return { ...base, entries: [...others, entry] };
}

/** Each recipe host's lock with the cut vendored set: every component that host or every host installs. */
function releaseLocks(entries: readonly ToolchainEntry[]): ReleaseRecord["locks"] {
  const hosts = [...new Set(entries.flatMap((entry) => (entry.host === null ? [] : [entry.host])))].sort();
  const locks: ReleaseRecord["locks"] = {};
  for (const host of hosts) {
    const own = entries
      .filter((entry) => entry.host === host || entry.host === null)
      .sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
    const components = own.map((entry) => ({
      id: entry.id,
      version: entry.version,
      sha12: entrySha12(entry),
      urls: entry.archives.map((archive) => archive.url),
      sha256s: entry.archives.map((archive) => archive.sha256 ?? ""),
    }));
    const pins: ToolchainLock["entries"] = {};
    for (const component of components) pins[component.id] = { version: component.version, sha12: component.sha12 };
    locks[host] = { lock: lockOf(pins), components };
  }
  return locks;
}

/** Refuses a tree that is not the reviewed one; answers the workspace version, the reviewed release and the URL. */
async function checkCut(options: CutOptions): Promise<{ version: string; url: string; tree: TreeDigest }> {
  const version = await checkedWorkspaceVersion(options.workspace);
  const reviewed = await reviewedRelease(options.inventory);
  if (reviewed === null) throw new ReleaseRefused(ReleaseRefusal.NoRelease, MESSAGE.NoRelease(options.inventory));
  if (reviewed.genex !== version)
    throw new ReleaseRefused(ReleaseRefusal.VersionMismatch, MESSAGE.ReviewedOther(reviewed.genex, version));
  const url = releaseAssetUrl(version, VENDOR_FILE, options.releaseBase);
  assertReleaseUrl(url);
  await checkVendor(options.tree, options.inventory);
  const found = await treeDigest(options.tree);
  const same =
    found.sha256 === reviewed.tree.sha256 && found.files === reviewed.tree.files && found.bytes === reviewed.tree.bytes;
  if (!same) throw new ReleaseRefused(ReleaseRefusal.TreeMismatch, MESSAGE.TreeMismatch(found, reviewed.tree));
  return { version, url, tree: found };
}

/** Refuses an `out` that holds anything: a cut never mixes with, or removes, what is there. */
async function assertEmptyOut(out: string): Promise<void> {
  const held = await readdir(out).catch(() => []);
  if (held.length > 0) throw new ReleaseRefused(ReleaseRefusal.OutNotEmpty, MESSAGE.OutNotEmpty(out));
}

/** Writes the record, the locks and the manifest inputs beside the archive in `stage`. */
async function writeCut(stage: string, record: ReleaseRecord, manifestInputs: unknown): Promise<void> {
  for (const [host, { lock }] of Object.entries(record.locks)) {
    await mkdir(path.join(stage, LOCKS_FOLDER, host), { recursive: true });
    await writeFile(path.join(stage, LOCKS_FOLDER, host, RUST_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  }
  await writeFile(path.join(stage, MANIFEST_INPUTS_FILE), `${JSON.stringify(manifestInputs, null, 2)}\n`);
  await writeFile(path.join(stage, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Cuts the release from the built vendored `tree`: refused (before anything is written) unless the
 * tree is the reviewed one and every version agrees; then the archive, record, locks and manifest
 * inputs are written beside `out` and renamed into place. Answers the record.
 */
export async function cutRelease(options: CutOptions): Promise<ReleaseRecord> {
  const { version, url, tree } = await checkCut(options);
  const out = path.resolve(options.out);
  await assertEmptyOut(out);
  const stage = `${out}.partial`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    const packed = await packArchive(options.tree, path.join(stage, VENDOR_FILE), VENDOR_ROOT);
    const archive = { url, bytes: packed.bytes, sha256: packed.sha256, format: "tar.gz", strip: 0, into: "" } as const;
    const recipeEntry: VendorRecipeEntry = {
      id: ToolchainId.RustVendor,
      version,
      host: null,
      target: null,
      licence: VENDOR_LICENCE,
      archives: [archive],
      tree,
    };
    const recipe = recipeWithVendor(options.recipe, recipeEntry);
    const record: ReleaseRecord = {
      schema: RECORD_SCHEMA,
      genex: version,
      tag: `genex-${version}`,
      vendor: { file: VENDOR_FILE, url, sha256: packed.sha256, bytes: packed.bytes, files: packed.files, tree },
      inventorySha256: sha256Of(await readFile(options.inventory)),
      workspaceLockSha256: sha256Of(await readFile(path.join(options.workspace, "Cargo.lock"))),
      recipeEntry,
      locks: releaseLocks(rustManifestOf(recipe)),
    };
    await writeCut(stage, record, rustStoreInputs(recipe));
    // `out` was checked empty (or absent): only an empty folder is removed to make room.
    await rmdir(out).catch(() => {});
    await rename(stage, out);
    return record;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** The most of a cut's `release.json` read: a record is a few kilobytes. */
const RECORD_MAX_BYTES = 1024 * 1024;

/** A local cut's vendored set, ready for the store's own verified install (`installRustVendor`): its entry, archive and tree pin. */
export interface CutVendor {
  entry: ToolchainEntry;
  /** The archive on disk, which a file-backed fetch serves under the entry's URL. */
  archive: string;
  /** The tree digest the unpacked `vendor/` must have. */
  pin: TreeDigest;
}

/** The cut's record, read as a plain file and shape-checked; refused `release-cut-unreadable`. */
async function readCutRecord(dir: string): Promise<ReleaseRecord> {
  const file = path.join(dir, RECORD_FILE);
  const bytes = await readRegularFile(file, RECORD_MAX_BYTES).catch(() => null);
  let value: unknown = null;
  try {
    value = bytes ? JSON.parse(bytes.toString("utf8")) : null;
  } catch {
    value = null;
  }
  const vendor = isJsonObject(value) && isJsonObject(value.vendor) ? value.vendor : null;
  const entry = isJsonObject(value) && isJsonObject(value.recipeEntry) ? value.recipeEntry : null;
  const shaped = vendor !== null && entry !== null && isJsonObject(value) && value.schema === RECORD_SCHEMA;
  // The archive's name is the cut's own, never a path: a record cannot point the install anywhere else.
  const trees = shaped && isTreeDigest(vendor.tree) && isTreeDigest(entry.tree);
  const archives = entry !== null && Array.isArray(entry.archives) && entry.archives.every(isJsonObject);
  if (!trees || !archives || vendor.file !== VENDOR_FILE)
    throw new ReleaseRefused(ReleaseRefusal.CutUnreadable, MESSAGE.CutUnreadable(file));
  return value as unknown as ReleaseRecord;
}

/** Whether a cut's recipe entry is the archive and tree its record names. */
function entryMatchesRecord(record: ReleaseRecord): boolean {
  const { recipeEntry, vendor } = record;
  const [archive, ...more] = recipeEntry.archives;
  const sameArchive = archive !== undefined && archive.sha256 === vendor.sha256 && archive.bytes === vendor.bytes;
  const sameTree = recipeEntry.tree.sha256 === vendor.tree.sha256 && recipeEntry.tree.files === vendor.tree.files;
  return more.length === 0 && sameArchive && sameTree && recipeEntry.id === ToolchainId.RustVendor;
}

/** A cut's recipe entry as the store reads a recipe's (shape and release host checked); refused `release-cut-unreadable`. */
function cutEntry(fields: Omit<VendorRecipeEntry, "tree">): ToolchainEntry {
  try {
    const [entry] = rustManifestOf({ schema: 1, entries: [fields] });
    if (entry) return entry;
  } catch {
    // A recipe the store would refuse is no cut's.
  }
  throw new ReleaseRefused(ReleaseRefusal.CutUnreadable, MESSAGE.CutUnreadable(RECORD_FILE));
}

/**
 * The vendored set of a locally cut release (`cut --out <dir>`), for a developer's dev store before
 * the owner publishes it (`dev-store.ts --stack rust-wgpu --release <dir>`): the record read as a
 * plain file, its recipe entry held to the release host and to its own record, and the archive (a
 * plain file, never a link) held to the recorded size and sha256 before anything installs it. The
 * store's install then verifies the archive again and the unpacked tree against `pin`.
 */
export async function readCutVendor(dir: string): Promise<CutVendor> {
  const record = await readCutRecord(dir);
  if (!entryMatchesRecord(record)) throw new ReleaseRefused(ReleaseRefusal.CutDigest, MESSAGE.CutDigest("record"));
  const { tree, ...fields } = record.recipeEntry;
  for (const { url } of fields.archives) assertReleaseUrl(url);
  const entry = cutEntry(fields);
  const archive = path.join(dir, VENDOR_FILE);
  const bytes = await readRegularFile(archive, record.vendor.bytes).catch(() => null);
  if (!bytes) throw new ReleaseRefused(ReleaseRefusal.CutUnreadable, MESSAGE.CutUnreadable(archive));
  if (bytes.length !== record.vendor.bytes || sha256Of(bytes) !== record.vendor.sha256)
    throw new ReleaseRefused(ReleaseRefusal.CutDigest, MESSAGE.CutDigest(VENDOR_FILE));
  return { entry, archive, pin: tree };
}

/**
 * Pins a published cut into the recipe (`rust-recipe.json`): its vendored set replaces any earlier
 * one. Refused, with the recipe untouched, when the entry names anything off the Genex release host.
 */
export async function pinRelease(recipeFile: string, record: ReleaseRecord): Promise<void> {
  assertSemver(record.recipeEntry.version);
  for (const archive of record.recipeEntry.archives) assertReleaseUrl(archive.url);
  const recipe = recipeWithVendor(JSON.parse(await readFile(recipeFile, "utf8")) as unknown, record.recipeEntry);
  rustManifestOf(recipe);
  await atomicWriteJson(recipeFile, recipe);
}

/**
 * Where genex resolves for a build: the release the recipe pins when it is the workspace's version;
 * otherwise this checkout's workspace for a dev or test build (before a publication, or ahead of
 * it), and nothing for a product build, which never builds from local sources.
 */
export async function resolveGenex(
  recipe: unknown,
  workspace: string,
  build: { dev: boolean },
): Promise<GenexResolution | null> {
  const version = await workspaceVersion(workspace);
  const entry = rustManifestOf(recipe).find((item) => item.id === ToolchainId.RustVendor && item.version === version);
  if (entry) return { source: GenexSource.Release, version, entry };
  return build.dev ? { source: GenexSource.Local, version, workspace } : null;
}

// ---------- building the release tree (cargo, through rust-env.ts) ----------

/** Runs one cargo command through the env helper over `workspace`; a failure is refused `release-cargo-failed`. */
async function cargo(args: readonly string[], workspace: string, what: string): Promise<void> {
  const env = { ...process.env, GENEX_RUST_WORKSPACE: workspace };
  try {
    await execFileAsync(process.execPath, [RUST_ENV, "--", "cargo", ...args], {
      cwd: REPO,
      env,
      maxBuffer: CARGO_MAX_BUFFER,
    });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim().split("\n").slice(-3).join(" ") ?? String(error);
    throw new ReleaseRefused(ReleaseRefusal.CargoFailed, MESSAGE.Cargo(what, detail));
  }
}

/** Re-vendors the allowlist offline into `<scratch>/vendor` from the lock the installed tree was vendored with. */
async function revendor(scratch: string): Promise<string> {
  const lock = path.join(rustToolchainLayout().dir, "vendor-manifest", "Cargo.lock");
  const manifestDir = path.join(scratch, "vendor-manifest");
  await mkdir(manifestDir, { recursive: true });
  // The package setup-toolchain.sh vendors (its name is in the lock), over the allowlist as committed.
  const header =
    '[package]\nname = "genex-spike-vendor"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n\n[lib]\npath = "lib.rs"\n\n';
  await writeFile(path.join(manifestDir, "Cargo.toml"), header + (await readFile(ALLOWLIST, "utf8")));
  await writeFile(path.join(manifestDir, "lib.rs"), "");
  await copyFile(lock, path.join(manifestDir, "Cargo.lock"));
  const vendor = path.join(scratch, VENDOR_ROOT);
  const args = ["vendor", "--quiet", "--offline", "--locked", "--versioned-dirs", "--respect-source-config", vendor];
  await cargo(args, manifestDir, "vendor");
  await rm(manifestDir, { recursive: true, force: true });
  return vendor;
}

/**
 * The workspace's package sources copied into `into`: the files git lists for it (tracked, plus
 * untracked ones it does not ignore, as `cargo package` would take them from the working tree),
 * or, outside git, every regular file; never anything under a `.git` or `target` folder.
 */
export async function copyPackageSources(workspace: string, into: string): Promise<void> {
  const listed = (await gitListedFiles(workspace)) ?? (await filesUnder(workspace));
  const files = listed.filter((rel) => !rel.split("/").some((segment) => UNCOPIED_FOLDERS.has(segment)));
  for (const rel of files) {
    const from = path.join(workspace, ...rel.split("/"));
    // A tracked file deleted from the working tree is not packaged.
    if (!existsSync(from)) continue;
    const to = path.join(into, ...rel.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

/** The files git lists under `dir` (tracked and untracked-not-ignored), or null when `dir` is not in a work tree. */
async function gitListedFiles(dir: string): Promise<string[] | null> {
  try {
    const args = ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."];
    const { stdout } = await execFileAsync("git", args, { maxBuffer: CARGO_MAX_BUFFER });
    return [...new Set(stdout.split("\0").filter((rel) => rel !== ""))].sort();
  } catch {
    return null;
  }
}

/**
 * The workspace's library crates (`crates/*`) as `cargo package` makes them: offline, unverified,
 * no lock inside, packaged from a copy under `scratch` so no crate records the commit it came from.
 */
async function packageGenex(workspace: string, version: string, scratch: string): Promise<string[]> {
  const crates = (await readdir(path.join(workspace, "crates"), { withFileTypes: true })).filter((e) =>
    e.isDirectory(),
  );
  const copy = path.join(scratch, PACKAGE_WORKSPACE);
  await rm(copy, { recursive: true, force: true });
  await copyPackageSources(workspace, copy);
  const target = path.join(
    process.env.CARGO_TARGET_DIR || path.join(REPO, ".studio-dev", "cargo-target"),
    PACKAGE_TARGET,
  );
  const packages = crates.flatMap((entry) => ["-p", entry.name]);
  const flags = [
    "--no-verify",
    "--offline",
    "--locked",
    "--allow-dirty",
    "--registry",
    "crates-io",
    "--exclude-lockfile",
  ];
  await cargo(["package", ...packages, ...flags, "--target-dir", target], copy, "package").finally(() =>
    rm(copy, { recursive: true, force: true }),
  );
  const made = crates.map((entry) => path.join(target, "package", `${entry.name}-${version}.crate`));
  if (!made.every((file) => existsSync(file)))
    throw new ReleaseRefused(ReleaseRefusal.CargoFailed, MESSAGE.NoCrates(target));
  return made.sort();
}

/** Every regular file under `dir`, `/`-separated and in byte order. */
async function filesUnder(dir: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  const entries = (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : Number(a.name > b.name),
  );
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesUnder(dir, child)));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

/** Unpacks one `.crate` into the vendored tree with the `.cargo-checksum.json` a directory source requires. */
export async function vendorCrate(vendor: string, crate: string): Promise<void> {
  const name = path.basename(crate, ".crate");
  await rm(path.join(vendor, name), { recursive: true, force: true });
  await execFileAsync("tar", ["-xzf", crate, "-C", vendor]);
  if (existsSync(path.join(vendor, name, CARGO_VCS_INFO_FILE))) {
    await rm(path.join(vendor, name), { recursive: true, force: true });
    throw new ReleaseRefused(ReleaseRefusal.CommitBound, MESSAGE.CommitBound(name));
  }
  const files: Record<string, string> = {};
  for (const rel of await filesUnder(path.join(vendor, name)))
    files[rel] = sha256Of(await readFile(path.join(vendor, name, ...rel.split("/"))));
  const checksum = { files, package: sha256Of(await readFile(crate)) };
  await writeFile(path.join(vendor, name, CARGO_CHECKSUM_FILE), JSON.stringify(checksum));
}

/** Builds the release's vendored tree under `scratch` (which must not hold one yet); answers its folder. */
export async function buildReleaseTree(scratch: string, workspace: string): Promise<string> {
  const version = await checkedWorkspaceVersion(workspace);
  if (existsSync(path.join(scratch, VENDOR_ROOT)))
    throw new ReleaseRefused(ReleaseRefusal.OutNotEmpty, MESSAGE.OutNotEmpty(scratch));
  const vendor = await revendor(scratch);
  for (const crate of await packageGenex(workspace, version, scratch)) await vendorCrate(vendor, crate);
  return vendor;
}

// ---------- the command line ----------

/** The value after `--<flag>`, if the flag is given. */
function option(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(`--${flag}`);
  return at >= 0 ? args[at + 1] : undefined;
}

/** The given `--tree`, or one built in a scratch folder under `.studio-dev` that `done` removes. */
async function releaseTree(
  args: readonly string[],
  workspace: string,
): Promise<{ tree: string; done: () => Promise<void> }> {
  const given = option(args, "tree");
  if (given !== undefined) return { tree: path.resolve(given), done: async () => {} };
  const scratch = path.join(REPO, ".studio-dev", "rust-release", `tree-${process.pid}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  return {
    tree: await buildReleaseTree(scratch, workspace),
    done: () => rm(scratch, { recursive: true, force: true }),
  };
}

async function bump(workspace: string, to: string | undefined): Promise<void> {
  if (to === undefined) throw new ReleaseRefused(ReleaseRefusal.Usage, MESSAGE.Usage);
  const manifestFile = path.join(workspace, "Cargo.toml");
  const lockFile = path.join(workspace, "Cargo.lock");
  const manifest = await readText(manifestFile);
  const next = bumpWorkspace(manifest, await readText(lockFile), manifestVersion(manifest, manifestFile), to);
  await writeFile(manifestFile, next.manifest);
  await writeFile(lockFile, next.lock);
  process.stdout.write(`bumped the genex workspace to ${to}: rewrite the inventory, review both and commit\n`);
}

async function cutCommand(args: readonly string[], workspace: string, inventory: string): Promise<void> {
  const out = option(args, "out");
  if (out === undefined) throw new ReleaseRefused(ReleaseRefusal.Usage, MESSAGE.Usage);
  await assertEmptyOut(path.resolve(out));
  const recipe: unknown = JSON.parse(await readFile(DEFAULT_RECIPE, "utf8"));
  const { tree, done } = await releaseTree(args, workspace);
  try {
    const releaseBase = option(args, "release-base");
    const record = await cutRelease({
      tree,
      workspace,
      inventory,
      out,
      recipe,
      ...(releaseBase ? { releaseBase } : {}),
    });
    process.stdout.write(
      `cut genex ${record.genex}: ${record.vendor.file} ${record.vendor.sha256} (${record.vendor.bytes} bytes) for ${record.vendor.url}\n` +
        `publishing it under ${record.tag} is the owner's step; then: rust-release.ts pin --from ${out}\n`,
    );
  } finally {
    await done();
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  const workspace = rustToolchainLayout().workspace;
  const inventory = option(args, "inventory") ?? DEFAULT_INVENTORY;
  if (command === "bump") return bump(workspace, args[0]);
  if (command === "cut") return cutCommand(args, workspace, inventory);
  if (command === "inventory") {
    const { tree, done } = await releaseTree(args, workspace);
    await writeReleaseInventory(tree, workspace, inventory).finally(done);
    process.stdout.write(`wrote ${inventory}: format it (biome format --write), review the diff and commit it\n`);
    return;
  }
  const from = option(args, "from");
  if (command === "pin" && from !== undefined) {
    const record = JSON.parse(await readFile(path.join(from, RECORD_FILE), "utf8")) as ReleaseRecord;
    const recipe = option(args, "recipe") ?? DEFAULT_RECIPE;
    await pinRelease(recipe, record);
    process.stdout.write(`pinned genex ${record.genex} into ${recipe}: format it, review the diff and commit it\n`);
    return;
  }
  const out = option(args, "out");
  if (command !== "tree" || out === undefined) throw new ReleaseRefused(ReleaseRefusal.Usage, MESSAGE.Usage);
  await mkdir(path.resolve(out), { recursive: true });
  const tree = await buildReleaseTree(path.resolve(out), workspace);
  process.stdout.write(`built the release's vendored tree at ${tree} (${JSON.stringify(await treeDigest(tree))})\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (!(error instanceof ReleaseRefused || error instanceof VendorRefused)) throw error;
    process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code: error.code, detail: error.message })}\n`);
    process.exitCode = RUST_ENV_REFUSAL_EXIT;
  });
}
