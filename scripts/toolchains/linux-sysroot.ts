// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the .pc files' own ${prefix} references are what this script writes.
/**
 * Builds the Linux x64 sysroot local artifact, `$GENEX_DEV_TOOLCHAINS/linux-sysroot-x64/<sha12>/`,
 * from two folders already in the developer's toolchains (nothing is fetched, nothing is linked):
 *
 * - `sysroot-linux-x64-x11/usr/{include,lib64}`: AlmaLinux 8's X11, Wayland and xkbcommon headers
 *   and the libraries GLFW's `find_package(X11)` looks for (no game links them: GLFW loads X11 at
 *   run time), taken from the image its `record.json` pins by digest;
 * - `glfw-wayland-fc7a27ac010b/*.h`: GLFW's Wayland protocol code, generated once by that image's
 *   wayland-scanner, written under `glfw-wayland/`;
 * - the link stubs a Rust · wgpu game's cpal (libasound) and gilrs (libudev) link through, built
 *   by the pinned zig for glibc 2.28 from the vendored binding crates
 *   (`native/linux-sysroot/manifest.json`): `usr/lib64/lib<link>.so` with the real SONAME and one
 *   empty function per `pub fn <prefix>…` the crate declares, its `.pc` file under
 *   `usr/lib64/pkgconfig/`, and `bin/pkg-config`, the small pkg-config those build scripts call
 *   (a Mac has none). Stubs are linked against, never run: players' systems have the libraries.
 *   The plan's alsa-lib and libudev headers are not added (the bindings are pre-generated and no
 *   authorized source served the AlmaLinux packages in M4.2).
 *
 * Its `manifest.json` uses the ANGLE manifests' format (`files` keyed by relative path, each with
 * `sha256` and `size`) and carries the image digest, the packages and both records; the folder's
 * name is the first 12 hex of that manifest's sha256, the pin `toolchain-store/manifest.ts`
 * records. The output is deterministic: the same inputs give the same bytes. `--check` derives the
 * manifest again and verifies the built folder file by file, writing nothing. SHA256SUMS is not
 * touched (it lists downloads; this is a local build).
 *
 *   node scripts/toolchains/linux-sysroot.ts [--check] [--archive <file>] [--zig <zig>] [--vendor <dir>]
 *
 * `--zig` defaults to the developer's `zig-0.16.0/zig`, `--vendor` to `GENEX_RUST_VENDOR_DIR` or the
 * spike folder's vendored crates.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ArchiveItemKind, writeTarGz } from "../../src/substrate/native-export-archive.ts";

const execFileAsync = promisify(execFile);

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SYSROOT_INPUT = "sysroot-linux-x64-x11";
const PROTOCOLS_INPUT = "glfw-wayland-fc7a27ac010b";
const OUTPUT = "linux-sysroot-x64";
/** Where the protocol code goes inside the artifact, beside `usr/`. */
const PROTOCOLS_FOLDER = "glfw-wayland";
/** The sysroot folders copied whole. */
const SYSROOT_FOLDERS = ["usr/include", "usr/lib64"] as const;
const MANIFEST_FILE = "manifest.json";
const RECORD_FILE = "record.json";
const PACKAGES_FILE = "packages.txt";
const MANIFEST_SCHEMA = 1;
const TARGET = "linux-x64-sysroot";
/** The link stub recipe: which binding crates get a stub, with which SONAME and `.pc` file. */
const STUB_RECIPE = path.join(REPO, "native", "linux-sysroot", "manifest.json");
const STUB_RECIPE_SCHEMA = 1;
/** Where the stubs and their `.pc` files go inside the artifact. */
const STUB_LIBDIR = "usr/lib64";
const PKG_CONFIG_DIR = "usr/lib64/pkgconfig";
const PKG_CONFIG_FILE = "bin/pkg-config";
/**
 * The pkg-config the sysroot carries for hosts without one (a Mac): the subset the `pkg-config`
 * crate uses, checked in beside the recipe.
 */
const PKG_CONFIG_SOURCE = path.join(REPO, "native", "linux-sysroot", "pkg-config");
/** The developer's zig the stubs are built with, under the toolchains folder. */
const DEV_ZIG = "zig-0.16.0/zig";
/** How long one stub's compile may take. */
const STUB_COMPILE_TIMEOUT_MS = 120_000;
/** A binding crate's declared function: `pub fn snd_pcm_open(`. */
const DECLARED_FUNCTION = (prefix: string) => new RegExp(`pub fn (${prefix}[A-Za-z0-9_]+)`, "g");
/** A crate name, version, prefix or link name the recipe may hold. */
const RECIPE_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** An image pinned by digest: `<name>@sha256:<64 hex>`. */
const PINNED_IMAGE = /@(sha256:[0-9a-f]{64})$/;

const MESSAGE = {
  NotPlain: (rel: string) => `${rel} is a link, a FIFO or another special file; only plain files are taken.`,
  NoDigest: (record: string) => `${record} pins no image digest.`,
  Digests: (a: string, b: string) => `The sysroot (${a}) and the protocol code (${b}) come from different images.`,
  Missing: (rel: string) => `${rel} is missing from the built sysroot.`,
  Extra: (rel: string) => `${rel} is in the built sysroot but not in its manifest.`,
  Differs: (rel: string) => `${rel} differs from the manifest the inputs give.`,
  NotBuilt: (folder: string) => `${folder} is not built: run node scripts/toolchains/linux-sysroot.ts.`,
  BadRecipe: `${STUB_RECIPE} is not a link stub recipe.`,
  ZigVersion: (found: string, pinned: string) => `zig ${found} is not the recipe's zig ${pinned}.`,
  NoFunctions: (crate: string) => `${crate} declares no function the stub recipe names.`,
  FlagValue: (flag: string) => `${flag} needs a value.`,
} as const;

/** One file the artifact holds, with the bytes it holds and its mode. */
interface Planned {
  rel: string;
  bytes: Buffer;
  mode: number;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const byPath = (a: Planned, b: Planned) => (a.rel < b.rel ? -1 : Number(a.rel > b.rel));

/** Every regular file under `root/rel`, listed without following a link; any other kind of entry is refused. */
async function plainFiles(root: string, rel: string): Promise<Array<{ rel: string; file: string }>> {
  const found: Array<{ rel: string; file: string }> = [];
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await plainFiles(root, child)));
    else if (entry.isFile()) found.push({ rel: child, file: path.join(root, child) });
    else throw new Error(MESSAGE.NotPlain(child));
  }
  return found;
}

/** A file's bytes and mode (0755 when any execute bit is set, else 0644), refused unless it is a plain file. */
async function readPlain(file: string, rel: string): Promise<{ bytes: Buffer; mode: number }> {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error(MESSAGE.NotPlain(rel));
  return { bytes: await readFile(file), mode: info.mode & 0o111 ? 0o755 : 0o644 };
}

/** The image digest a record pins (an `image` spelled with its digest, or `repoDigests`). */
function imageDigest(record: Record<string, unknown>, name: string): string {
  const named = [record.image, ...(Array.isArray(record.repoDigests) ? record.repoDigests : [])];
  for (const value of named) {
    const match = typeof value === "string" ? PINNED_IMAGE.exec(value) : null;
    if (match?.[1]) return match[1];
  }
  throw new Error(MESSAGE.NoDigest(name));
}

const packagesOf = (record: Record<string, unknown>): string[] =>
  Array.isArray(record.packages) ? record.packages.filter((item): item is string => typeof item === "string") : [];

/** The sysroot's headers and libraries, then the protocol code under `glfw-wayland/`. */
async function inputFiles(sysroot: string, protocols: string): Promise<Planned[]> {
  const files: Planned[] = [];
  for (const folder of SYSROOT_FOLDERS)
    for (const found of await plainFiles(sysroot, folder))
      files.push({ rel: found.rel, ...(await readPlain(found.file, found.rel)) });
  for (const entry of await readdir(protocols, { withFileTypes: true })) {
    if (!entry.name.endsWith(".h")) continue;
    const rel = `${PROTOCOLS_FOLDER}/${entry.name}`;
    files.push({ rel, ...(await readPlain(path.join(protocols, entry.name), rel)) });
  }
  return files;
}

/** One row of the link stub recipe. */
interface StubRow {
  crate: string;
  version: string;
  prefix: string;
  soname: string;
  link: string;
  pc: { name: string; version: string; description: string };
}

/** The recipe file: the glibc and zig the stubs are built for and with, and one row per stub. */
interface StubRecipe {
  glibc: string;
  zig: string;
  stubs: StubRow[];
}

/** Where the stubs are built from: the pinned zig and the vendored binding crates. */
interface StubInputs {
  zig: string;
  vendor: string;
}

const isWord = (value: unknown): value is string => typeof value === "string" && RECIPE_WORD.test(value);

function isStubRow(value: unknown): value is StubRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const pc = row.pc as Record<string, unknown> | null | undefined;
  const words = [row.crate, row.version, row.prefix, row.soname, row.link].every(isWord);
  return words && isWord(pc?.name) && isWord(pc?.version) && typeof pc?.description === "string";
}

/** The checked-in recipe, shape-checked: every name a plain word, so none can reach outside its folder. */
async function readRecipe(): Promise<StubRecipe> {
  const value = JSON.parse(await readFile(STUB_RECIPE, "utf8"));
  const shaped = value?.schema === STUB_RECIPE_SCHEMA && isWord(value.glibc) && isWord(value.zig);
  if (!shaped || !Array.isArray(value.stubs) || !value.stubs.every(isStubRow)) throw new Error(MESSAGE.BadRecipe);
  return { glibc: value.glibc, zig: value.zig, stubs: value.stubs };
}

/** The C source of one stub: one empty function per `pub fn <prefix>…` the crate's `src/*.rs` declare, sorted. */
async function stubSource(vendor: string, row: StubRow): Promise<{ source: string; symbols: number }> {
  const crate = `${row.crate}-${row.version}`;
  const src = path.join(vendor, crate, "src");
  const names = new Set<string>();
  for (const found of (await plainFiles(src, ".")).filter((file) => file.rel.endsWith(".rs")))
    for (const match of (await readFile(found.file, "utf8")).matchAll(DECLARED_FUNCTION(row.prefix)))
      if (match[1]) names.add(match[1]);
  if (names.size === 0) throw new Error(MESSAGE.NoFunctions(crate));
  const sorted = [...names].sort();
  const lines = [`/* Link stub generated by linux-sysroot.ts from ${crate}. Never executed. */`];
  for (const name of sorted) lines.push(`void ${name}(void) {}`);
  return { source: `${lines.join("\n")}\n`, symbols: sorted.length };
}

/** zig's version, held to the recipe's. */
async function zigVersion(zig: string, pinned: string): Promise<string> {
  const { stdout } = await execFileAsync(zig, ["version"], { timeout: STUB_COMPILE_TIMEOUT_MS });
  const found = stdout.trim();
  if (found !== pinned) throw new Error(MESSAGE.ZigVersion(found, pinned));
  return found;
}

/** One stub compiled by zig for `x86_64-linux-gnu.<glibc>` in a private folder, its caches beside it. */
async function compileStub(zig: string, glibc: string, row: StubRow, source: string): Promise<Buffer> {
  const work = await mkdtemp(path.join(os.tmpdir(), "genex-linux-stub-"));
  try {
    const input = path.join(work, `${row.link}.c`);
    const output = path.join(work, `lib${row.link}.so`);
    await writeFile(input, source);
    const args = ["cc", "-target", `x86_64-linux-gnu.${glibc}`, "-shared", "-fPIC", "-nostdlib", "-O0", "-s"];
    args.push(`-Wl,-soname,${row.soname}`, "-o", output, input);
    const env = {
      PATH: "/usr/bin:/bin",
      ZIG_GLOBAL_CACHE_DIR: path.join(work, "global"),
      ZIG_LOCAL_CACHE_DIR: path.join(work, "local"),
    };
    await execFileAsync(zig, args, { env, timeout: STUB_COMPILE_TIMEOUT_MS });
    return await readFile(output);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** One stub's `.pc` file, as alsa-lib and systemd install theirs (one library, the sysroot's include folder). */
function pcText(row: StubRow): string {
  return [
    "prefix=/usr",
    "libdir=${prefix}/lib64",
    "includedir=${prefix}/include",
    "",
    `Name: ${row.pc.name}`,
    `Description: ${row.pc.description}`,
    `Version: ${row.pc.version}`,
    `Libs: -L\${libdir} -l${row.link}`,
    "Cflags: -I${includedir}",
    "",
  ].join("\n");
}

/** The stubs, their `.pc` files and the sysroot's pkg-config, with the record the manifest keeps of them. */
async function stubFiles(inputs: StubInputs): Promise<{ files: Planned[]; record: Record<string, unknown> }> {
  const recipe = await readRecipe();
  const zig = await zigVersion(inputs.zig, recipe.zig);
  const files: Planned[] = [];
  const stubs: Array<Record<string, unknown>> = [];
  for (const row of recipe.stubs) {
    const { source, symbols } = await stubSource(inputs.vendor, row);
    const bytes = await compileStub(inputs.zig, recipe.glibc, row, source);
    files.push({ rel: `${STUB_LIBDIR}/lib${row.link}.so`, bytes, mode: 0o644 });
    files.push({ rel: `${PKG_CONFIG_DIR}/${row.pc.name}.pc`, bytes: Buffer.from(pcText(row)), mode: 0o644 });
    const from = `${row.crate}-${row.version}`;
    stubs.push({ crate: row.crate, version: row.version, from, soname: row.soname, symbols, source: sha256(source) });
  }
  const pkgConfig = await readPlain(PKG_CONFIG_SOURCE, PKG_CONFIG_FILE);
  files.push({ rel: PKG_CONFIG_FILE, bytes: pkgConfig.bytes, mode: 0o755 });
  return { files, record: { glibc: recipe.glibc, zig, stubs, pkgConfig: sha256(pkgConfig.bytes) } };
}

/** The artifact's files and manifest, derived from the inputs alone. */
async function plan(tools: string, stubInputs: StubInputs): Promise<{ files: Planned[]; manifest: Buffer }> {
  const sysroot = path.join(tools, SYSROOT_INPUT);
  const protocols = path.join(tools, PROTOCOLS_INPUT);
  const sysrootRecord = JSON.parse(await readFile(path.join(sysroot, RECORD_FILE), "utf8"));
  const protocolsRecord = JSON.parse(await readFile(path.join(protocols, RECORD_FILE), "utf8"));
  const digest = imageDigest(sysrootRecord, `${SYSROOT_INPUT}/${RECORD_FILE}`);
  const protocolsDigest = imageDigest(protocolsRecord, `${PROTOCOLS_INPUT}/${RECORD_FILE}`);
  if (digest !== protocolsDigest) throw new Error(MESSAGE.Digests(digest, protocolsDigest));
  const packages = [...new Set([...packagesOf(sysrootRecord), ...packagesOf(protocolsRecord)])].sort();
  const record = {
    image: sysrootRecord.image,
    imageDigest: digest,
    platform: sysrootRecord.platform,
    base: sysrootRecord.base,
    packages,
    sysroot: { from: SYSROOT_INPUT, folders: SYSROOT_FOLDERS, record: sysrootRecord },
    protocols: { from: PROTOCOLS_INPUT, into: PROTOCOLS_FOLDER, record: protocolsRecord },
  };
  const stubs = await stubFiles(stubInputs);
  const files = [...(await inputFiles(sysroot, protocols)), ...stubs.files];
  files.push({ rel: RECORD_FILE, bytes: Buffer.from(`${JSON.stringify(record, null, 2)}\n`), mode: 0o644 });
  files.push({ rel: PACKAGES_FILE, bytes: Buffer.from(`${packages.join("\n")}\n`), mode: 0o644 });
  files.sort(byPath);
  const listed = Object.fromEntries(
    files.map((file) => [file.rel, { sha256: sha256(file.bytes), size: file.bytes.length }]),
  );
  const manifest = { schema: MANIFEST_SCHEMA, target: TARGET, ...record, linkStubs: stubs.record, files: listed };
  return { files, manifest: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
}

/** Writes the planned files into a fresh staging folder beside the final one, then renames it in. */
async function build(output: string, final: string, files: readonly Planned[], manifest: Buffer): Promise<void> {
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(path.join(output, ".staging-"));
  await chmod(staging, 0o755);
  for (const file of files) {
    const to = path.join(staging, ...file.rel.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, file.bytes, { mode: file.mode, flag: "wx" });
  }
  await writeFile(path.join(staging, MANIFEST_FILE), manifest, { mode: 0o644, flag: "wx" });
  await rename(staging, final);
}

/** Every plain file in the built folder, and a problem for any entry that is not a file or a folder. */
async function builtFiles(final: string): Promise<{ present: Set<string>; problems: string[] }> {
  const present = new Set<string>();
  const problems: string[] = [];
  for (const name of await readdir(final)) {
    const info = await lstat(path.join(final, name));
    if (info.isDirectory()) for (const found of await plainFiles(final, name)) present.add(found.rel);
    else if (info.isFile()) present.add(name);
    else problems.push(MESSAGE.NotPlain(name));
  }
  return { present, problems };
}

/** The problems of the built folder against the planned files: every file present, equal and listed. */
async function verify(final: string, files: readonly Planned[], manifest: Buffer): Promise<string[]> {
  const built = await lstat(final).catch(() => null);
  if (!built?.isDirectory()) return [MESSAGE.NotBuilt(final)];
  const { present, problems } = await builtFiles(final);
  for (const file of [...files, { rel: MANIFEST_FILE, bytes: manifest, mode: 0o644 }]) {
    if (!present.delete(file.rel)) {
      problems.push(MESSAGE.Missing(file.rel));
      continue;
    }
    const bytes = await readFile(path.join(final, ...file.rel.split("/")));
    if (!bytes.equals(file.bytes)) problems.push(MESSAGE.Differs(file.rel));
  }
  for (const rel of present) problems.push(MESSAGE.Extra(rel));
  return problems;
}

/** The store reader consumes this deterministic archive without a top-level wrapper. */
async function archive(file: string, files: readonly Planned[], manifest: Buffer) {
  const items = [...files, { rel: MANIFEST_FILE, bytes: manifest, mode: 0o644 }].map((entry) => ({
    kind: ArchiveItemKind.File,
    path: entry.rel,
    content: { bytes: entry.bytes },
    executable: entry.mode === 0o755,
  }));
  const output = await open(file, "wx", 0o644);
  try {
    await writeTarGz(items, {
      write: async (bytes) => {
        await output.writeFile(bytes);
      },
    });
  } finally {
    await output.close();
  }
  const bytes = await readFile(file);
  return { file, sha256: sha256(bytes), bytes: bytes.length, format: "tar.gz" };
}

/** The value after `flag` on the command line, or null when the flag is absent. */
function flagValue(flag: string): string | null {
  const at = process.argv.indexOf(flag);
  if (at < 0) return null;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(MESSAGE.FlagValue(flag));
  return value;
}

async function main(): Promise<void> {
  const tools = process.env.GENEX_DEV_TOOLCHAINS || path.join(REPO, ".studio-dev", "toolchains");
  const check = process.argv.includes("--check");
  const zig = flagValue("--zig") ?? path.join(tools, DEV_ZIG);
  const vendor =
    flagValue("--vendor") ??
    (process.env.GENEX_RUST_VENDOR_DIR || path.join(REPO, ".studio-dev", "spike-toolchain", "vendor"));
  const { files, manifest } = await plan(tools, { zig: path.resolve(zig), vendor: path.resolve(vendor) });
  const digest = sha256(manifest);
  const output = path.join(tools, OUTPUT);
  const final = path.join(output, digest.slice(0, 12));
  const exists = (await lstat(final).catch(() => null)) !== null;
  if (!check && !exists) await build(output, final, files, manifest);
  const problems = await verify(final, files, manifest);
  const facts = {
    folder: path.relative(tools, final),
    manifestSha256: digest,
    manifestBytes: manifest.length,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    built: !check && !exists,
    problems,
  };
  const file = flagValue("--archive");
  const packed = file && problems.length === 0 ? await archive(path.resolve(file), files, manifest) : null;
  console.log(JSON.stringify({ ...facts, archive: packed }, null, 2));
  if (problems.length > 0) process.exitCode = 1;
}

await main();
