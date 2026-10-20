/**
 * Android's libcolyseus, built from the pinned source (MP-1b, owner decision G12): upstream ships
 * no Android prebuilt, so the store pins what an offline build needs beside the source tarball
 * (`ColyseusAsset.Source`) and builds it twice.
 *
 * - zig {@link COLYSEUS_ZIG_VERSION} per host: upstream's `build.zig` refuses any zig but 0.15.x,
 *   while the store's own zig (C++ and Linux links) stays 0.16.0.
 * - The zig_msgpack source archive at the commit `build.zig.zon` names, unpacked into the folder
 *   named by its package hash ({@link ZIG_MSGPACK_PACKAGE}) so `zig build --system` finds it and
 *   never fetches.
 * - The person's pinned NDK (`ANDROID_PINS.ndk`, a user-side component) gives bionic's headers and
 *   crt files.
 *
 * Every input is checked before anything is written: its size and sha256 against the pin, then
 * every entry (no hard link, no symlink but the ones the pin lists with their exact targets, no
 * entry over the input's cap, no more in all than its total); the store's own extractor refuses a
 * name that is absolute or climbs, and a refused input leaves its folder as it was.
 *
 * The build runs zig through the injected `run` (the core's `ProcessSandbox.run`): no network,
 * writes only its work folder. It builds twice at the same paths from fresh caches; only a
 * byte-equal pair is laid out, as `lib<name>.a` in `<dest>/<triple>/`, the folder layout
 * `toolchain-store/colyseus.ts` gives every prebuilt triple. A pair that differs is refused with
 * the differing archives and their members named.
 */
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { MINUTE_MS } from "../../shared/duration.ts";
import {
  ANDROID_PINS,
  ArchiveFormat,
  COLYSEUS_ASSETS,
  COLYSEUS_LIBRARIES,
  ColyseusAsset,
  ColyseusTriple,
  colyseusAssetUrl,
  ToolchainError,
  ToolchainHost,
  ToolchainProblem,
} from "../../shared/toolchain.ts";
import { openNoFollow } from "../fsx.ts";
import { shellQuote } from "../shell-quote.ts";
import type { RunRequest, RunResult } from "../spawn.ts";
import { type ArchiveEntry, ArchiveEntryType, extractArchive, listArchive } from "./archive.ts";
import { colyseusLibraryFile } from "./colyseus.ts";

/** The zig release upstream's `build.zig` accepts (it `@compileError`s on 0.16 and later). */
export const COLYSEUS_ZIG_VERSION = "0.15.2";
/** The zig_msgpack commit libcolyseus 0.18.10's `build.zig.zon` names. */
export const ZIG_MSGPACK_COMMIT = "47c15d217efebd17a585dd04125f9b6b6f659d5a";
/** The package hash that `build.zig.zon` gives zig_msgpack: `zig build --system` looks the package up by it. */
export const ZIG_MSGPACK_PACKAGE = "zig_msgpack-0.0.14-evvueGolBQBs_m726tBf4ISJQqC926AM96EtxZy9LUaI";
/** The largest a built library may be: the biggest, libhttp_zig.a, is 11 MB. */
export const COLYSEUS_BUILT_LIBRARY_BYTES_MAX = 64 * 1024 * 1024;

/** The archives an Android build needs. Wire values (recipe file names): never rename one. */
export const ColyseusBuildInput = {
  /** The libcolyseus source tree (the same pin as `ColyseusAsset.Source`). */
  Source: ColyseusAsset.Source,
  /** zig for an Apple-silicon Mac. */
  ZigMacArm64: "zig-aarch64-macos-0.15.2.tar.xz",
  /** zig for an x86_64 Linux host. */
  ZigLinuxX64: "zig-x86_64-linux-0.15.2.tar.xz",
  /** zig_msgpack's tree at {@link ZIG_MSGPACK_COMMIT}, as GitHub archives it. */
  ZigMsgpack: `zig-msgpack-${ZIG_MSGPACK_COMMIT}.tar.gz`,
} as const;
export type ColyseusBuildInput = (typeof ColyseusBuildInput)[keyof typeof ColyseusBuildInput];

/** How one input archive unpacks into the component, and the caps its entries are held to. */
export interface BuildArchiveSpec {
  format: ArchiveFormat;
  strip: number;
  /** The component folder it unpacks into. */
  into: string;
  /** The largest one entry may be. */
  entryBytesMax: number;
  /** The most the archive may unpack to. */
  unpackedBytesMax: number;
  /** The only symlinks it may hold (name after `strip` → exact target). */
  links: Readonly<Record<string, string>>;
}

/** One input's pin: where it comes from, its size and sha256 (checked against the downloaded bytes, 2026-10-20). */
export interface BuildInputPin extends BuildArchiveSpec {
  url: string;
  bytes: number;
  sha256: string;
}

const MIB = 1024 * 1024;
const ZIG_CAPS = { entryBytesMax: 256 * MIB, unpackedBytesMax: 512 * MIB, links: {} } as const;
const ZIG_DOWNLOAD = `https://ziglang.org/download/${COLYSEUS_ZIG_VERSION}`;

/**
 * Each input's pin. zig: ziglang.org's `download/index.json` (0.15.2) states size and sha256, and
 * the downloaded bytes agree. zig_msgpack: the archive's sha256 taken on download; `zig fetch`
 * gives it {@link ZIG_MSGPACK_PACKAGE}, the hash `build.zig.zon` names. The source tarball holds
 * one symlink, `third_party/uthash/include -> src`.
 */
export const COLYSEUS_BUILD_INPUTS = {
  [ColyseusBuildInput.Source]: {
    url: colyseusAssetUrl(ColyseusAsset.Source),
    bytes: COLYSEUS_ASSETS[ColyseusAsset.Source].bytes,
    sha256: COLYSEUS_ASSETS[ColyseusAsset.Source].sha256,
    format: ArchiveFormat.TarGz,
    strip: 0,
    into: "source",
    entryBytesMax: 64 * MIB,
    unpackedBytesMax: 256 * MIB,
    links: { "third_party/uthash/include": "src" },
  },
  [ColyseusBuildInput.ZigMacArm64]: {
    url: `${ZIG_DOWNLOAD}/${ColyseusBuildInput.ZigMacArm64}`,
    bytes: 50635984,
    sha256: "3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b",
    format: ArchiveFormat.TarXz,
    strip: 1,
    into: "zig",
    ...ZIG_CAPS,
  },
  [ColyseusBuildInput.ZigLinuxX64]: {
    url: `${ZIG_DOWNLOAD}/${ColyseusBuildInput.ZigLinuxX64}`,
    bytes: 53733924,
    sha256: "02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239",
    format: ArchiveFormat.TarXz,
    strip: 1,
    into: "zig",
    ...ZIG_CAPS,
  },
  [ColyseusBuildInput.ZigMsgpack]: {
    url: `https://github.com/zigcc/zig-msgpack/archive/${ZIG_MSGPACK_COMMIT}.tar.gz`,
    bytes: 77942,
    sha256: "30a0d7c9a3ab8002ccfcd18745a0b27aaac73eff3de881b157c30f65709e90a9",
    format: ArchiveFormat.TarGz,
    strip: 1,
    into: `packages/${ZIG_MSGPACK_PACKAGE}`,
    entryBytesMax: 4 * MIB,
    unpackedBytesMax: 16 * MIB,
    links: {},
  },
} as const satisfies Record<ColyseusBuildInput, BuildInputPin>;

/** The zig each host builds with; a host not listed has no Android build. */
const ZIG_BY_HOST: Readonly<Partial<Record<ToolchainHost, ColyseusBuildInput>>> = {
  [ToolchainHost.MacArm64]: ColyseusBuildInput.ZigMacArm64,
  [ToolchainHost.LinuxX64]: ColyseusBuildInput.ZigLinuxX64,
};

/** The zig target of each triple built from source. */
const ZIG_TARGETS = { [ColyseusTriple.Android]: "aarch64-linux-android" } as const;
/** A triple libcolyseus is built from source for. */
export type SourceTriple = keyof typeof ZIG_TARGETS;

/** The component's folders, from {@link COLYSEUS_BUILD_INPUTS}' `into`. */
const SOURCE_FOLDER = COLYSEUS_BUILD_INPUTS[ColyseusBuildInput.Source].into;
const ZIG_FOLDER = COLYSEUS_BUILD_INPUTS[ColyseusBuildInput.ZigMacArm64].into;
const PACKAGES_FOLDER = "packages";
/** How long one build may take. */
const BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
/** How much of a failed build's stderr the refusal keeps. */
const STDERR_TAIL_CHARS = 600;
/** The build rounds compared. */
const BUILD_ROUNDS = 2;
/** The NDK's revision in its `source.properties`. */
const NDK_REVISION = /^Pkg\.Revision\s*=\s*(\S+)\s*$/m;
/** What a static library starts with. */
const AR_MAGIC = Buffer.from("!<arch>\n", "latin1");
const AR_HEADER_BYTES = 60;
/** The mode of a laid-out triple folder, as `mkdir` gives the prebuilt ones. */
const TRIPLE_FOLDER_MODE = 0o755;
/**
 * The vendored example schema the install step's drift check compares with its fixture. The
 * release tarball leaves `platforms/` out, so the build copy places the fixture there: the check
 * then compares a file with itself, and nothing compiled changes.
 */
const VENDORED_SCHEMA = {
  copy: "platforms/raylib/src/test_room_state.h",
  fixture: "tests/schema/test_room_state.h",
} as const;
/**
 * The only PATH a build gets. zig 0.15.2's Mach-O linker cannot read the macOS 26 SDK's libSystem
 * stubs, so its build runner fails to link once `xcrun` finds that SDK; without `/usr/bin` it
 * links against the stubs zig ships. An Android build reads no Apple SDK.
 */
const BUILD_PATH = "/bin";

const MESSAGE = {
  Size: (input: string, bytes: number) => `${input} is ${bytes} bytes, not the pinned size.`,
  Digest: (input: string, sha256: string) => `${input} has sha256 ${sha256}, not the pinned one.`,
  HardLink: (name: string) => `${name} is a hard link; a build input holds none.`,
  Link: (name: string, target: string) => `${name} is a link to ${target}, which the pin does not list.`,
  Entry: (name: string, bytes: number, max: number) =>
    `${name} is ${bytes} bytes; no entry of this input is larger than ${max}.`,
  Total: (bytes: number, max: number) => `The input unpacks to ${bytes} bytes; the limit is ${max}.`,
  NotFolder: (rel: string) => `${rel} is a link or not a folder.`,
  NotFile: (rel: string) => `${rel} is a link or not a file.`,
  Ndk: (found: string | null) =>
    `The NDK is ${found ?? "of no readable revision"}; libcolyseus builds with the pinned ${ANDROID_PINS.ndk}.`,
  Failed: (round: number, stderr: string) =>
    `Build ${round + 1} of libcolyseus failed: ${stderr.trim().slice(-STDERR_TAIL_CHARS)}`,
  NotLibrary: (name: string) => `${name} is not a static library.`,
  NoCore: (name: string) => `The build produced no ${name}.`,
  Differ: (diffs: string) => `Two builds of libcolyseus from the same source differ: ${diffs}.`,
  Rounds: "libcolyseus: both build rounds must run.",
} as const;

const refuse = (problem: ToolchainProblem, message: string) => new ToolchainError(problem, message);

/** The inputs an Android build on `host` installs, in recipe order, or null where no zig is pinned. */
export function colyseusBuildInputs(host: ToolchainHost): ColyseusBuildInput[] | null {
  const zig = ZIG_BY_HOST[host];
  return zig === undefined ? null : [ColyseusBuildInput.Source, zig, ColyseusBuildInput.ZigMsgpack];
}

/** The files that prove a `colyseus-source` component installed: the source's build file, zig and the zig package. */
export function colyseusSourceProbeFiles(): string[] {
  return [`${SOURCE_FOLDER}/build.zig`, `${ZIG_FOLDER}/zig`, `${PACKAGES_FOLDER}/${ZIG_MSGPACK_PACKAGE}/build.zig.zon`];
}

// ---------- the inputs ----------

/** Refuses (`integrity`) a downloaded input whose size or sha256 is not its pin. */
export async function verifyColyseusBuildInput(file: string, input: ColyseusBuildInput): Promise<void> {
  const pin = COLYSEUS_BUILD_INPUTS[input];
  const info = await lstat(file);
  if (!info.isFile() || info.size !== pin.bytes)
    throw refuse(ToolchainProblem.Integrity, MESSAGE.Size(input, info.size));
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  const sha256 = hash.digest("hex");
  if (sha256 !== pin.sha256) throw refuse(ToolchainProblem.Integrity, MESSAGE.Digest(input, sha256));
}

/** An entry's name after `strip` leading components (a leading `./` is none). */
function strippedName(name: string, strip: number): string {
  return name
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .slice(strip)
    .join("/");
}

/** Refuses (`archive`) one entry: a hard link, an unlisted symlink, or one over the cap. */
function checkEntry(entry: ArchiveEntry, spec: BuildArchiveSpec): void {
  if (entry.type === ArchiveEntryType.Hardlink) throw refuse(ToolchainProblem.Archive, MESSAGE.HardLink(entry.name));
  if (entry.type === ArchiveEntryType.Symlink) {
    const target = entry.linkTarget ?? "";
    const listed = spec.links[strippedName(entry.name, spec.strip)];
    if (listed !== target) throw refuse(ToolchainProblem.Archive, MESSAGE.Link(entry.name, target));
  }
  if (entry.size > spec.entryBytesMax)
    throw refuse(ToolchainProblem.Archive, MESSAGE.Entry(entry.name, entry.size, spec.entryBytesMax));
}

/** Refuses (`archive`) an entry list `spec` does not admit, before anything is written. */
export function checkBuildInputEntries(entries: readonly ArchiveEntry[], spec: BuildArchiveSpec): void {
  let total = 0;
  for (const entry of entries) {
    checkEntry(entry, spec);
    total += entry.size;
  }
  if (total > spec.unpackedBytesMax)
    throw refuse(ToolchainProblem.Archive, MESSAGE.Total(total, spec.unpackedBytesMax));
}

/**
 * Unpacks an input archive (already verified) into `component/<into>`: its entries checked
 * ({@link checkBuildInputEntries}), extracted into a staging folder beside the component, then
 * swapped in whole. A refusal leaves the component as it was and the staging folder removed.
 */
export async function installBuildArchive(
  file: string,
  spec: BuildArchiveSpec,
  component: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  checkBuildInputEntries(await listArchive(file, spec.format, options), spec);
  await mkdir(path.dirname(component), { recursive: true });
  const staging = await mkdtemp(`${component}.staging-`);
  try {
    await extractArchive(file, spec.format, staging, { strip: spec.strip, into: spec.into, signal: options.signal });
    const target = path.join(component, ...spec.into.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(path.join(staging, ...spec.into.split("/")), target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Installs one downloaded input into the component: verified against its pin, then {@link installBuildArchive}. */
export async function installColyseusBuildInput(
  file: string,
  input: ColyseusBuildInput,
  component: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await verifyColyseusBuildInput(file, input);
  await installBuildArchive(file, COLYSEUS_BUILD_INPUTS[input], component, options);
}

// ---------- the build ----------

/** Where an Android build reads and writes. */
export interface ColyseusAndroidBuild {
  /** The installed `colyseus-source` component: `source/`, `zig/`, `packages/<hash>/`. */
  component: string;
  /** The person's NDK at {@link ANDROID_PINS}`.ndk`. */
  ndk: string;
  /** The per-triple library folders (`tools/colyseus`, or a component's `lib/`). */
  dest: string;
  /** A folder the build may fill and remove: both rounds run in it, at the same paths. */
  work: string;
  triple?: SourceTriple;
}

/** What the build runs with: the core's `ProcessSandbox.run`. */
export interface ColyseusAndroidDeps {
  run: (request: RunRequest) => Promise<RunResult>;
  signal?: AbortSignal;
}

/** `root/rel` after checking that every segment is a real folder (never a link). */
async function realFolder(root: string, rel: string): Promise<string> {
  let at = root;
  for (const segment of rel.split("/").filter(Boolean)) {
    at = path.join(at, segment);
    const info = await lstat(at).catch(() => null);
    if (!info?.isDirectory()) throw refuse(ToolchainProblem.Archive, MESSAGE.NotFolder(rel));
  }
  return at;
}

/** `folder/name` after checking it is a regular file (never a link). */
async function realFile(folder: string, name: string, rel: string): Promise<string> {
  const file = path.join(folder, name);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) throw refuse(ToolchainProblem.Archive, MESSAGE.NotFile(rel));
  return file;
}

/** Refuses (`probe`) an NDK whose `source.properties` names another revision than the pin. */
async function checkNdk(ndk: string): Promise<void> {
  const properties = await readFile(path.join(ndk, "source.properties"), "utf8").catch(() => "");
  const revision = NDK_REVISION.exec(properties)?.[1] ?? null;
  if (revision !== ANDROID_PINS.ndk) throw refuse(ToolchainProblem.Probe, MESSAGE.Ndk(revision));
}

/** The paths one round uses: the same every round, so nothing path-dependent can differ. */
function roundPaths(work: string) {
  const build = path.join(work, "build");
  return {
    build,
    source: path.join(build, "src"),
    cache: path.join(build, "cache"),
    globalCache: path.join(build, "global-cache"),
    prefix: path.join(build, "out"),
  };
}

/** The sandboxed zig run of one round: no network, writes only `work`, reads the component and the NDK. */
export function colyseusAndroidBuildRequest(
  input: { zig: string; packages: string; component: string; ndk: string; work: string; triple: SourceTriple },
  signal?: AbortSignal,
): RunRequest {
  const at = roundPaths(input.work);
  const argv = [
    input.zig,
    "build",
    "install",
    `-Dtarget=${ZIG_TARGETS[input.triple]}`,
    "-Doptimize=ReleaseFast",
    "-Dexamples=false",
    // zig 0.15.2 names each Zig module's `builtin.zig` folder at random (`global-cache/b/<random>`)
    // and writes that path into the module's line table: stripping the Zig modules' debug info is
    // what makes two builds byte-equal. The C core keeps its own.
    "-Dstrip=true",
    `-Dandroid-ndk=${input.ndk}`,
    "--system",
    input.packages,
    "--cache-dir",
    at.cache,
    "--global-cache-dir",
    at.globalCache,
    "--prefix",
    at.prefix,
  ];
  return {
    command: argv.map(shellQuote).join(" "),
    cwd: at.source,
    env: { PATH: BUILD_PATH, HOME: input.work },
    timeoutMs: BUILD_TIMEOUT_MS,
    label: "colyseus-android-build",
    reapGroup: true,
    signal,
    policy: { allowedDomains: [], allowWrite: [input.work], allowRead: [input.component, input.ndk] },
  };
}

/** A fresh build copy of the source at the round's paths, with the vendored schema the drift check reads. */
async function prepareRound(source: string, work: string): Promise<void> {
  const at = roundPaths(work);
  await rm(at.build, { recursive: true, force: true });
  await mkdir(at.build, { recursive: true });
  await cp(source, at.source, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  const copy = path.join(at.source, ...VENDORED_SCHEMA.copy.split("/"));
  await mkdir(path.dirname(copy), { recursive: true });
  const fixture = await readFile(path.join(at.source, ...VENDORED_SCHEMA.fixture.split("/")));
  await writeFile(copy, fixture, { flag: "wx" });
}

/** A built library's bytes, read without following a link: refused unless a regular `ar` archive within the cap. */
async function readLibrary(file: string, name: string): Promise<Buffer> {
  const handle = await openNoFollow(file, constants.O_RDONLY).catch(() => {
    throw refuse(ToolchainProblem.Archive, MESSAGE.NotFile(name));
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw refuse(ToolchainProblem.Archive, MESSAGE.NotFile(name));
    if (info.size > COLYSEUS_BUILT_LIBRARY_BYTES_MAX)
      throw refuse(ToolchainProblem.Archive, MESSAGE.Entry(name, info.size, COLYSEUS_BUILT_LIBRARY_BYTES_MAX));
    const bytes = await handle.readFile();
    if (!bytes.subarray(0, AR_MAGIC.length).equals(AR_MAGIC))
      throw refuse(ToolchainProblem.Archive, MESSAGE.NotLibrary(name));
    return bytes;
  } finally {
    await handle.close();
  }
}

/** The libraries one round produced that the crate links (`COLYSEUS_LIBRARIES`), in link order; the core is required. */
async function roundLibraries(prefix: string): Promise<Map<string, Buffer>> {
  const lib = await realFolder(prefix, "lib");
  const present = new Set(await readdir(lib));
  const found = new Map<string, Buffer>();
  for (const library of COLYSEUS_LIBRARIES) {
    const name = colyseusLibraryFile(library);
    if (present.has(name)) found.set(name, await readLibrary(path.join(lib, name), name));
  }
  const core = colyseusLibraryFile(COLYSEUS_LIBRARIES[0] ?? "colyseus");
  if (!found.has(core)) throw refuse(ToolchainProblem.Archive, MESSAGE.NoCore(core));
  return found;
}

/** One round: a fresh copy, zig, the libraries it produced; the build folder is removed afterwards. */
async function buildRound(
  request: RunRequest,
  source: string,
  work: string,
  round: number,
  deps: ColyseusAndroidDeps,
): Promise<Map<string, Buffer>> {
  await prepareRound(source, work);
  try {
    const result = await deps.run(request);
    if (result.code !== 0) throw refuse(ToolchainProblem.Prewarm, MESSAGE.Failed(round, result.stderr));
    return await roundLibraries(roundPaths(work).prefix);
  } finally {
    await rm(roundPaths(work).build, { recursive: true, force: true });
  }
}

/** A member's name and how many bytes of its body the name takes (BSD `#1/<len>`); null for a symbol or name table. */
function memberName(raw: string, body: Buffer, longNames: string): { name: string; skip: number } | null {
  if (raw === "/" || raw === "//" || raw.startsWith("/SYM64/") || raw.startsWith("__.SYMDEF")) return null;
  if (raw.startsWith("#1/")) {
    const length = Number(raw.slice(3));
    const name = body.subarray(0, length).toString("latin1").replace(/\0+$/, "");
    return name.startsWith("__.SYMDEF") ? null : { name, skip: length };
  }
  if (/^\/\d+$/.test(raw)) {
    const offset = Number(raw.slice(1));
    const end = longNames.indexOf("/\n", offset);
    return { name: longNames.slice(offset, end < 0 ? undefined : end), skip: 0 };
  }
  return { name: raw.replace(/\/$/, ""), skip: 0 };
}

/** `name`, or `name#2`, `name#3`… when an archive holds it more than once. */
function uniqueName(members: ReadonlyMap<string, Buffer>, name: string): string {
  let unique = name;
  for (let copy = 2; members.has(unique); copy++) unique = `${name}#${copy}`;
  return unique;
}

/** The members of an `ar` archive by name (GNU and BSD long names), or null when it does not parse. */
export function arMembers(bytes: Buffer): Map<string, Buffer> | null {
  if (!bytes.subarray(0, AR_MAGIC.length).equals(AR_MAGIC)) return null;
  const members = new Map<string, Buffer>();
  let longNames = "";
  let at = AR_MAGIC.length;
  while (at + AR_HEADER_BYTES <= bytes.length) {
    const header = bytes.subarray(at, at + AR_HEADER_BYTES).toString("latin1");
    const size = Number(header.slice(48, 58).trim());
    const start = at + AR_HEADER_BYTES;
    const malformed = !Number.isSafeInteger(size) || size < 0 || header.slice(58, 60) !== "`\n";
    if (malformed || start + size > bytes.length) return null;
    const body = bytes.subarray(start, start + size);
    const raw = header.slice(0, 16).trimEnd();
    const named = memberName(raw, body, longNames);
    if (raw === "//") longNames = body.toString("latin1");
    else if (named !== null) members.set(uniqueName(members, named.name), body.subarray(named.skip));
    at = start + size + (size % 2);
  }
  return members;
}

/** The members of two builds of one library that differ (present in one only, or other bytes). */
export function differingMembers(a: Buffer, b: Buffer): string[] {
  const left = arMembers(a);
  const right = arMembers(b);
  if (left === null || right === null) return ["(the whole archive)"];
  const names = new Set([...left.keys(), ...right.keys()]);
  const differ = [...names].filter((name) => {
    const one = left.get(name);
    const other = right.get(name);
    return one === undefined || other === undefined || !one.equals(other);
  });
  return differ.length > 0 ? differ : ["(the archive's symbol table or layout)"];
}

/** Refuses (`integrity`) two rounds that are not byte-equal, naming each differing library and its members. */
function assertSameBuilds(first: ReadonlyMap<string, Buffer>, second: ReadonlyMap<string, Buffer>): void {
  const diffs: string[] = [];
  for (const name of new Set([...first.keys(), ...second.keys()])) {
    const a = first.get(name);
    const b = second.get(name);
    if (a === undefined || b === undefined) diffs.push(`${name} (built once only)`);
    else if (!a.equals(b)) diffs.push(`${name} (${differingMembers(a, b).join(", ")})`);
  }
  if (diffs.length > 0) throw refuse(ToolchainProblem.Integrity, MESSAGE.Differ(diffs.join("; ")));
}

/** Writes `libraries` into `<dest>/<triple>/`, staged beside `dest` and swapped in whole. */
async function layOut(libraries: ReadonlyMap<string, Buffer>, dest: string, triple: SourceTriple): Promise<void> {
  await mkdir(dest, { recursive: true });
  const staging = await mkdtemp(`${dest}.staging-`);
  try {
    for (const [name, bytes] of libraries)
      await writeFile(path.join(staging, name), bytes, { flag: "wx", mode: 0o644 });
    // mkdtemp makes the folder owner-only; a triple's folder is as readable as its prebuilt siblings.
    await chmod(staging, TRIPLE_FOLDER_MODE);
    const target = path.join(dest, triple);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Builds Android's libcolyseus from the installed component twice, offline, at the same paths
 * from fresh caches, and lays out the libraries in `<dest>/<triple>/` only when both builds are
 * byte-equal. The component's folders and zig must be real (no link), and the NDK the pinned
 * revision, before anything runs. A refusal leaves `dest` as it was.
 */
export async function buildColyseusAndroid(
  build: ColyseusAndroidBuild,
  deps: ColyseusAndroidDeps,
): Promise<{ triple: SourceTriple; libraries: string[] }> {
  const triple = build.triple ?? ColyseusTriple.Android;
  const source = await realFolder(build.component, SOURCE_FOLDER);
  const zig = await realFile(await realFolder(build.component, ZIG_FOLDER), "zig", `${ZIG_FOLDER}/zig`);
  const packages = await realFolder(build.component, PACKAGES_FOLDER);
  await realFolder(build.component, `${PACKAGES_FOLDER}/${ZIG_MSGPACK_PACKAGE}`);
  await checkNdk(build.ndk);
  const request = colyseusAndroidBuildRequest(
    { zig, packages, component: build.component, ndk: build.ndk, work: build.work, triple },
    deps.signal,
  );
  const rounds: Array<Map<string, Buffer>> = [];
  for (let round = 0; round < BUILD_ROUNDS; round++)
    rounds.push(await buildRound(request, source, build.work, round, deps));
  const [first, second] = rounds;
  if (first === undefined || second === undefined) throw new Error(MESSAGE.Rounds);
  assertSameBuilds(first, second);
  await layOut(first, build.dest, triple);
  return { triple, libraries: [...first.keys()] };
}
