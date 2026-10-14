/**
 * The vendored crate set's gate and release inputs (M1.5). The vendored tree is the only crate
 * source a Rust game builds from, so anything in it that runs or links other than compiled Rust
 * source is reviewed by a person and committed in `scripts/toolchains/rust-inventory.json`:
 *
 *   node scripts/toolchains/rust-vendor.ts check     [--vendor <dir>] [--inventory <file>]
 *   node scripts/toolchains/rust-vendor.ts inventory [--vendor <dir>] [--inventory <file>]
 *   node scripts/toolchains/rust-vendor.ts archive   --out <dir> [--inventory <file>]
 *
 * - `check` refuses a build script, proc macro or non-source file the inventory does not list
 *   (`inventory-new-entry`), an entry for something the tree no longer holds
 *   (`inventory-stale-entry`), a GL backend crate (`vendor-gl-crate`: WebGPU core is the floor) and
 *   anything in the tree that is not a plain folder or file (`vendor-not-plain-file`: a link, a
 *   FIFO), which it never follows or opens. The default tree is the installed toolchain's.
 * - `inventory` rewrites the inventory from the tree: a release change a person reviews.
 * - `archive` builds the release inputs into `--out` (publishing them is an owner step): the
 *   vendored tree re-vendored offline from the allowlist through `rust-env.ts` (`cargo vendor`
 *   over the manifest `vendor-allowlist.toml` makes, with the lock the installed tree was vendored
 *   from), checked as above and packed; the `genex` sources (the tracked files of
 *   `native/genex-rust`); the sysroot manifest (the pinned Rust archives); and
 *   `release-inputs.json` naming each with its sha256.
 *
 * An archive is a gzipped ustar stream with sorted entries under one root folder, owners, groups
 * and times zeroed, modes 0644 or 0755 and long paths in PAX headers, so the same tree packs into
 * the same bytes. It is written beside its name and renamed into place only when complete.
 *
 * A non-source file is one whose first 8 KiB hold a NUL byte (prebuilt libraries, images, fonts,
 * data blobs) or that carries an execute bit; text a reviewer can read in the crate is source.
 *
 * A refusal is one line on stderr, `genex-rust-vendor-refusal: {"code":…,"detail":…}`, and exit 78.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { RUST_ENV_REFUSAL_EXIT, rustToolchainLayout } from "./rust-env.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const DEFAULT_INVENTORY = path.join(REPO, "scripts", "toolchains", "rust-inventory.json");
const ALLOWLIST = path.join(REPO, "scripts", "spike", "rust-wgpu", "vendor-allowlist.toml");
const GENEX_WORKSPACE = "native/genex-rust";
/** How much of a file is read to tell text from a binary. */
const SNIFF_BYTES = 8 * 1024;
const TAR_BLOCK = 512;
/** ustar's name field; a longer path goes into a PAX header. */
const USTAR_NAME_BYTES = 100;
const FILE_MODE = 0o644;
const EXEC_MODE = 0o755;
const EXEC_BITS = 0o111;
const GZIP_LEVEL = 9;
/** Crates of a GL backend: WebGPU core is the floor, so the vendored tree never holds them. */
const GL_CRATES: ReadonlySet<string> = new Set(["glow", "khronos-egl", "glutin", "glutin_egl_sys", "glutin_wgl_sys"]);
/** A versioned vendor folder: `<name>-<semver>` (`cargo vendor --versioned-dirs`). */
const VERSIONED_DIR = /^(.+?)-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)$/;
const REFUSAL_PREFIX = "genex-rust-vendor-refusal: ";
const SYSROOT_GROUP = "rust";
const PINS_BEGIN = "<!-- genex-spike-pins:begin -->";
const PINS_END = "<!-- genex-spike-pins:end -->";

/** Why the gate refused. Wire values: CI and tests match them. */
export const VendorRefusal = {
  Usage: "usage",
  VendorMissing: "vendor-missing",
  NotAPlainFile: "vendor-not-plain-file",
  GlCrate: "vendor-gl-crate",
  InventoryNew: "inventory-new-entry",
  InventoryStale: "inventory-stale-entry",
  InventoryUnreadable: "inventory-unreadable",
  CargoVendorFailed: "cargo-vendor-failed",
  LockMissing: "vendor-lock-missing",
} as const;
export type VendorRefusal = (typeof VendorRefusal)[keyof typeof VendorRefusal];

const MESSAGE = {
  Usage:
    "usage: rust-vendor.ts check|inventory [--vendor <dir>] [--inventory <file>] | rust-vendor.ts archive --out <dir> [--inventory <file>]",
  VendorMissing: (dir: string) => `no vendored crates at ${dir}`,
  NotPlain: (file: string) => `${file} is not a plain folder or file: never followed or packed`,
  Gl: (crate: string) => `${crate} is vendored: a GL backend crate (WebGPU core is the floor)`,
  New: (entries: readonly string[]) =>
    `not in the reviewed inventory (rewrite it with \`rust-vendor.ts inventory\` after review): ${entries.join("; ")}`,
  Stale: (entries: readonly string[]) =>
    `the inventory lists what the vendored tree no longer holds: ${entries.join("; ")}`,
  Unreadable: (file: string, why: string) => `the inventory ${file} cannot be read: ${why}`,
  CargoVendor: (status: number | null) => `cargo vendor through rust-env.ts exited ${status}`,
  LockMissing: (file: string) => `no vendor lock at ${file}: the installed tree's lock is the one re-vendored`,
} as const;

/** What one vendored crate holds that a person reviews. */
export interface CrateEntry {
  /** The build script cargo runs, relative to the crate. */
  buildScript?: string;
  /** Whether the crate is a proc macro (it runs inside the compiler). */
  procMacro?: true;
  /** Binary or executable files, relative and sorted. */
  nonSource?: string[];
}

/** The committed inventory: every vendored crate (by its folder) that has something to review. */
export interface Inventory {
  about?: string;
  crates: Record<string, CrateEntry>;
}

/** One packed archive. */
export interface PackedArchive {
  file: string;
  sha256: string;
  bytes: number;
  files: number;
}

/** A refusal on its way to the one typed stderr line. */
export class VendorRefused extends Error {
  readonly code: VendorRefusal;
  constructor(code: VendorRefusal, detail: string) {
    super(detail);
    this.code = code;
  }
}

const INVENTORY_ABOUT =
  "Every build script, proc macro and non-source file (binary or executable) in the vendored crate set, by vendored folder. Reviewed by a person; written by `node scripts/toolchains/rust-vendor.ts inventory`; `check` fails on any entry missing here (plan: vendored-set policy).";

/** The entry's kind of folder or file, read without following it: a link, FIFO or device is refused. */
async function plainEntry(file: string): Promise<"dir" | "file"> {
  const info = await lstat(file);
  if (info.isDirectory()) return "dir";
  if (info.isFile()) return "file";
  throw new VendorRefused(VendorRefusal.NotAPlainFile, MESSAGE.NotPlain(file));
}

/** Every file under `dir`, relative and `/`-separated, sorted; anything but plain folders and files is refused. */
async function plainFiles(dir: string, rel = ""): Promise<string[]> {
  const files: string[] = [];
  const names = (await readdir(path.join(dir, rel))).sort();
  for (const name of names) {
    const child = rel ? `${rel}/${name}` : name;
    const kind = await plainEntry(path.join(dir, child));
    if (kind === "dir") files.push(...(await plainFiles(dir, child)));
    else files.push(child);
  }
  return files;
}

/** The `key = value` pairs of each `[table]` of a cargo manifest, read line by line (normalized manifests are flat). */
function manifestTables(text: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  let current = new Map<string, string>();
  tables.set("", current);
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = new Map();
      tables.set(header[1] ?? "", current);
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (pair) current.set(pair[1] ?? "", (pair[2] ?? "").trim());
  }
  return tables;
}

const unquoted = (value: string | undefined) => (value ?? "").replace(/^"(.*)"$/, "$1");

/** The crate's build script: `build = "<path>"`, none for `build = false`, else `build.rs` when the crate has one. */
function buildScript(pkg: Map<string, string> | undefined, files: readonly string[]): string | undefined {
  const declared = pkg?.get("build");
  if (declared === "false") return undefined;
  if (declared !== undefined && declared !== "true") return unquoted(declared);
  return files.includes("build.rs") ? "build.rs" : undefined;
}

/** Whether `[lib]` makes the crate a proc macro. */
function isProcMacro(lib: Map<string, string> | undefined): boolean {
  return lib?.get("proc-macro") === "true" || lib?.get("proc_macro") === "true";
}

/** Whether a file is not reviewable text: a NUL byte in its first bytes, or an execute bit. */
async function isNonSource(file: string): Promise<boolean> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if ((info.mode & EXEC_BITS) !== 0) return true;
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, info.size));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** What one crate folder holds that a person reviews, or null when nothing. */
async function scanCrate(dir: string): Promise<CrateEntry | null> {
  const files = await plainFiles(dir);
  const manifest = files.includes("Cargo.toml") ? await readFile(path.join(dir, "Cargo.toml"), "utf8") : "";
  const tables = manifestTables(manifest);
  const entry: CrateEntry = {};
  const script = buildScript(tables.get("package"), files);
  if (script !== undefined) entry.buildScript = script;
  if (isProcMacro(tables.get("lib"))) entry.procMacro = true;
  const nonSource: string[] = [];
  for (const rel of files) if (await isNonSource(path.join(dir, rel))) nonSource.push(rel);
  if (nonSource.length > 0) entry.nonSource = nonSource;
  return Object.keys(entry).length > 0 ? entry : null;
}

/** The crate name of a vendored folder (`glow-0.16.0` → `glow`). */
function crateName(folder: string): string {
  return VERSIONED_DIR.exec(folder)?.[1] ?? folder;
}

/** What the vendored tree holds that a person reviews, by crate folder, sorted; refuses links, FIFOs and GL crates. */
export async function scanVendor(vendor: string): Promise<Record<string, CrateEntry>> {
  const kind = await plainEntry(vendor).catch((error: unknown) => {
    if (error instanceof VendorRefused) throw error;
    throw new VendorRefused(VendorRefusal.VendorMissing, MESSAGE.VendorMissing(vendor));
  });
  if (kind !== "dir") throw new VendorRefused(VendorRefusal.VendorMissing, MESSAGE.VendorMissing(vendor));
  const crates: Record<string, CrateEntry> = {};
  for (const folder of (await readdir(vendor)).sort()) {
    const dir = path.join(vendor, folder);
    if ((await plainEntry(dir)) !== "dir") continue;
    if (GL_CRATES.has(crateName(folder))) throw new VendorRefused(VendorRefusal.GlCrate, MESSAGE.Gl(folder));
    const entry = await scanCrate(dir);
    if (entry) crates[folder] = entry;
  }
  return crates;
}

/** One line per reviewed thing an entry names: `<crate>: build script build.rs`. */
function reviewLines(crate: string, entry: CrateEntry): string[] {
  const lines: string[] = [];
  if (entry.buildScript !== undefined) lines.push(`${crate}: build script ${entry.buildScript}`);
  if (entry.procMacro) lines.push(`${crate}: proc macro`);
  for (const file of entry.nonSource ?? []) lines.push(`${crate}: non-source file ${file}`);
  return lines;
}

const describeAll = (crates: Record<string, CrateEntry>) =>
  new Set(Object.entries(crates).flatMap(([crate, entry]) => reviewLines(crate, entry)));

/** What the tree holds beyond the inventory, and what the inventory lists that the tree does not hold. */
export function compareInventory(
  found: Record<string, CrateEntry>,
  inventory: Inventory,
): { added: string[]; stale: string[] } {
  const have = describeAll(found);
  const listed = describeAll(inventory.crates);
  return {
    added: [...have].filter((line) => !listed.has(line)),
    stale: [...listed].filter((line) => !have.has(line)),
  };
}

/** The committed inventory, read as data. */
export async function readInventory(file: string): Promise<Inventory> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Inventory>;
    if (typeof parsed.crates !== "object" || parsed.crates === null) throw new Error("no `crates` object");
    return { crates: parsed.crates };
  } catch (error) {
    throw new VendorRefused(VendorRefusal.InventoryUnreadable, MESSAGE.Unreadable(file, (error as Error).message));
  }
}

/** Refuse a vendored tree that holds anything the inventory does not list, or lacks anything it lists. */
export async function checkVendor(vendor: string, inventoryFile: string): Promise<void> {
  const inventory = await readInventory(inventoryFile);
  const { added, stale } = compareInventory(await scanVendor(vendor), inventory);
  if (added.length > 0) throw new VendorRefused(VendorRefusal.InventoryNew, MESSAGE.New(added));
  if (stale.length > 0) throw new VendorRefused(VendorRefusal.InventoryStale, MESSAGE.Stale(stale));
}

/** Rewrite the inventory from the tree (a release change a person reviews). */
export async function writeInventory(vendor: string, inventoryFile: string): Promise<void> {
  const crates = await scanVendor(vendor);
  const inventory: Inventory = { about: INVENTORY_ABOUT, crates };
  await writeFile(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`);
}

/** An octal ustar number field of `length` bytes (digits, then NUL). */
function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** One 512-byte ustar header; `name` must fit its 100 bytes (a longer path rides a PAX header before it). */
function ustarHeader(name: string, size: number, mode: number, type: "0" | "x"): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(name, 0, USTAR_NAME_BYTES, "utf8");
  header.write(octal(mode, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(size, 12), 124, "ascii");
  header.write(octal(0, 12), 136, "ascii");
  header.fill(" ", 148, 156);
  header.write(type, 156, "ascii");
  header.write("ustar\u000000", 257, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

const padding = (size: number) => Buffer.alloc((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);

/** A PAX record `"<len> path=<name>\n"`, whose length counts its own digits. */
function paxPath(name: string): Buffer {
  const body = ` path=${name}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length += 1;
  return Buffer.from(`${length}${body}`);
}

/**
 * The headers that name `name`: its ustar header, after a PAX record carrying the whole path when
 * it does not fit ustar's name field (the ustar header then holds the path cut to fit, which every
 * PAX reader replaces with the record's).
 */
function entryHeaders(name: string, size: number, mode: number): Buffer[] {
  const own = ustarHeader(name, size, mode, "0");
  if (Buffer.byteLength(name) <= USTAR_NAME_BYTES) return [own];
  const record = paxPath(name);
  const shortName = `PaxHeaders/${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;
  return [ustarHeader(shortName, record.length, FILE_MODE, "x"), record, padding(record.length), own];
}

/** The tar stream of `files` (under `dir`) as `<root>/<file>`, every file opened without following a link. */
async function* tarStream(dir: string, root: string, files: readonly string[]): AsyncGenerator<Buffer> {
  for (const rel of files) {
    const handle = await open(path.join(dir, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new VendorRefused(VendorRefusal.NotAPlainFile, MESSAGE.NotPlain(path.join(dir, rel)));
      const mode = (info.mode & EXEC_BITS) !== 0 ? EXEC_MODE : FILE_MODE;
      const body = await handle.readFile();
      yield* entryHeaders(`${root}/${rel}`, body.length, mode);
      yield body;
      yield padding(body.length);
    } finally {
      await handle.close();
    }
  }
  yield Buffer.alloc(TAR_BLOCK * 2);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Pack the listed files of `dir` under `root` into a gzipped tar at `out`, renamed into place when complete. */
async function packFiles(dir: string, files: readonly string[], out: string, root: string): Promise<PackedArchive> {
  await mkdir(path.dirname(out), { recursive: true });
  const partial = `${out}.partial`;
  try {
    await pipeline(tarStream(dir, root, files), createGzip({ level: GZIP_LEVEL }), createWriteStream(partial));
    await rename(partial, out);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const bytes = (await lstat(out)).size;
  return { file: out, sha256: await sha256File(out), bytes, files: files.length };
}

/** Pack every file of a tree under `root`; a link, FIFO or device anywhere refuses it before anything is written. */
export async function packArchive(dir: string, out: string, root: string): Promise<PackedArchive> {
  const files = await plainFiles(dir);
  return packFiles(dir, files, out, root);
}

/** The tracked files of the `genex` workspace, as git lists them. */
function trackedGenexFiles(): string[] {
  const listed = spawnSync("git", ["ls-files", "-z", "--", GENEX_WORKSPACE], { cwd: REPO, encoding: "utf8" });
  if (listed.status !== 0) throw new Error(`git ls-files ${GENEX_WORKSPACE} failed: ${listed.stderr}`);
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => file.slice(GENEX_WORKSPACE.length + 1))
    .sort();
}

/** The pinned Rust sysroot archives (`pins.md`'s `rust` rows): file, url and sha256. */
async function sysrootManifest(pins: string): Promise<Array<{ file: string; url: string; sha256: string }>> {
  const lines = (await readFile(pins, "utf8")).split("\n");
  const begin = lines.findIndex((line) => line.startsWith(PINS_BEGIN));
  const end = lines.findIndex((line) => line.startsWith(PINS_END));
  return lines
    .slice(begin + 1, Math.max(begin + 1, end))
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells[1] === SYSROOT_GROUP)
    .map((cells) => ({ file: cells[2] ?? "", url: cells[3] ?? "", sha256: cells[4] ?? "" }));
}

/** Write the allowlist manifest beside the installed tree's lock and re-vendor it offline through rust-env.ts. */
async function revendor(out: string): Promise<string> {
  const layout = rustToolchainLayout();
  const lock = path.join(layout.dir, "vendor-manifest", "Cargo.lock");
  if (!(await lstat(lock).catch(() => null))?.isFile())
    throw new VendorRefused(VendorRefusal.LockMissing, MESSAGE.LockMissing(lock));
  const manifestDir = path.join(out, "vendor-manifest");
  await mkdir(manifestDir, { recursive: true });
  // The package setup-toolchain.sh vendors (its name is in the lock), over the allowlist as committed.
  const header =
    '[package]\nname = "genex-spike-vendor"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n\n[lib]\npath = "lib.rs"\n\n';
  await writeFile(path.join(manifestDir, "Cargo.toml"), header + (await readFile(ALLOWLIST, "utf8")));
  await writeFile(path.join(manifestDir, "lib.rs"), "");
  await copyFile(lock, path.join(manifestDir, "Cargo.lock"));
  const vendor = path.join(out, "vendor");
  const args = ["vendor", "--quiet", "--offline", "--locked", "--versioned-dirs", "--respect-source-config", vendor];
  const run = spawnSync(process.execPath, [RUST_ENV, "--", "cargo", ...args], {
    cwd: REPO,
    env: { ...process.env, GENEX_RUST_WORKSPACE: manifestDir },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (run.status !== 0) throw new VendorRefused(VendorRefusal.CargoVendorFailed, MESSAGE.CargoVendor(run.status));
  return vendor;
}

/** Build the release inputs into `out`: vendored archive, genex sources, sysroot manifest and their index. */
async function archive(out: string, inventoryFile: string): Promise<void> {
  const vendor = await revendor(out);
  await checkVendor(vendor, inventoryFile);
  const vendored = await packArchive(vendor, path.join(out, "genex-vendor.tar.gz"), "vendor");
  await rm(vendor, { recursive: true, force: true });
  const sources = await packFiles(
    path.join(REPO, GENEX_WORKSPACE),
    trackedGenexFiles(),
    path.join(out, "genex-sources.tar.gz"),
    "genex-rust",
  );
  const sysroot = path.join(out, "rust-sysroot-manifest.json");
  await writeFile(sysroot, `${JSON.stringify(await sysrootManifest(rustToolchainLayout().pins), null, 2)}\n`);
  const lock = path.join(out, "vendor-manifest", "Cargo.lock");
  const inputs = {
    vendor: { ...vendored, file: path.basename(vendored.file), crates: Object.keys(await lockedPackages(lock)).length },
    genexSources: { ...sources, file: path.basename(sources.file) },
    sysrootManifest: { file: path.basename(sysroot), sha256: await sha256File(sysroot) },
    vendorLockSha256: await sha256File(lock),
    inventorySha256: await sha256File(inventoryFile),
  };
  await writeFile(path.join(out, "release-inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
}

/** The registry packages a lock names, by `name-version` (the vendored folders). */
async function lockedPackages(lock: string): Promise<Record<string, true>> {
  const packages: Record<string, true> = {};
  let name = "";
  for (const line of (await readFile(lock, "utf8")).split("\n")) {
    const pair = /^(name|version|checksum) = "(.*)"$/.exec(line);
    if (pair?.[1] === "name") name = pair[2] ?? "";
    if (pair?.[1] === "version") name = `${name}-${pair[2] ?? ""}`;
    if (pair?.[1] === "checksum") packages[name] = true;
  }
  return packages;
}

/** The value after `--<flag>`, if the flag is given. */
function option(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(`--${flag}`);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  const inventory = option(args, "inventory") ?? DEFAULT_INVENTORY;
  const vendor = option(args, "vendor") ?? rustToolchainLayout().vendor;
  if (command === "check") {
    await checkVendor(vendor, inventory);
    process.stdout.write(`ok: every build script, proc macro and non-source file in ${vendor} is reviewed\n`);
    return;
  }
  if (command === "inventory") {
    await writeInventory(vendor, inventory);
    process.stdout.write(`wrote ${inventory}: review the diff before committing it\n`);
    return;
  }
  const out = option(args, "out");
  if (command !== "archive" || out === undefined) throw new VendorRefused(VendorRefusal.Usage, MESSAGE.Usage);
  await archive(path.resolve(out), inventory);
  process.stdout.write(`wrote the release inputs into ${out} (publishing them is an owner step)\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (!(error instanceof VendorRefused)) throw error;
    process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code: error.code, detail: error.message })}\n`);
    process.exitCode = RUST_ENV_REFUSAL_EXIT;
  });
}
