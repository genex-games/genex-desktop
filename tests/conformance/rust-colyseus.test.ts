/**
 * MP-1a, libcolyseus in the store: the pinned Colyseus native-sdk prebuilts laid out one folder
 * per native triple (`toolchain-store/colyseus.ts`), the lane's triple → folder map
 * (`main/rust-colyseus.ts`), the components a `[net]` export needs (none for Live), and the
 * Windows admission of the relay client's imports. The hostile table hands the store's unpacker
 * archives that climb, name absolute paths, carry links, oversized or non-library entries, miss
 * the core library or fail their pin, and asserts each installs nothing and writes nothing
 * outside its folder.
 *
 * The real row lays out the pinned assets a dev toolchain downloaded (`setup-toolchain.sh --with
 * colyseus`, `<toolchain>/downloads`); it skips without them, and `GENEX_REQUIRE_TOOLCHAINS=1`
 * turns the skip into a failure.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { crc32, gzipSync } from "node:zlib";
import { GameStack } from "../../src/shared/game-project.ts";
import {
  ArchiveFormat,
  COLYSEUS_ASSETS,
  ColyseusAsset,
  ColyseusTriple,
  RUST_NET_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  ToolchainProblem,
} from "../../src/shared/toolchain.ts";
import {
  COLYSEUS_ABSENT_FOLDER,
  COLYSEUS_LIB_DIR_ENV,
  ColyseusRefusal,
  colyseusBuildEnv,
  colyseusComponentFolder,
  resolveColyseusLibDir,
} from "../../src/main/rust-colyseus.ts";
import { admitRustPe, RUST_WINDOWS_NET_DLLS } from "../../src/substrate/native-gate-pe.ts";
import {
  COLYSEUS_ENTRY_BYTES_MAX,
  colyseusProbeFiles,
  installColyseusArchive,
  installColyseusAsset,
  thinToArm64,
} from "../../src/substrate/toolchain-store/colyseus.ts";
import { manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { writePe } from "../helpers/pe.ts";
import { tmpDir } from "../helpers/tmp.ts";

// ---------- hand-built archives ----------

const BLOCK = 512;
const AR = "!<arch>\n";
/** A minimal static library: the global header and nothing else, enough for the layout's magic check. */
const LIBRARY = `${AR}member`;

const octal = (value: number, digits: number) => `${value.toString(8).padStart(digits, "0")}\0`;

/** One ustar header with a correct checksum. */
function tarHeader(name: string, type: string, size: number, linkname = ""): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(type === "5" ? 0o755 : 0o644, 7), 100, "latin1");
  block.write(octal(0, 7), 108, "latin1");
  block.write(octal(0, 7), 116, "latin1");
  block.write(octal(size, 11), 124, "latin1");
  block.write(octal(0, 11), 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(type, 156, "latin1");
  block.write(linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

/** One archive entry: a file with its bytes, a folder (name ends in `/`), or a symlink or hard link. */
type Entry = { name: string; data?: Buffer | string; link?: string; hard?: string };

/** `entries` as a `.tar.gz`, the Linux asset's format. */
function tarGz(entries: readonly Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.link !== undefined) parts.push(tarHeader(entry.name, "2", 0, entry.link));
    else if (entry.hard !== undefined) parts.push(tarHeader(entry.name, "1", 0, entry.hard));
    else if (entry.name.endsWith("/")) parts.push(tarHeader(entry.name, "5", 0));
    else {
      const data = Buffer.from(entry.data ?? "");
      const rest = data.length % BLOCK;
      parts.push(tarHeader(entry.name, "0", data.length), data, Buffer.alloc(rest === 0 ? 0 : BLOCK - rest));
    }
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)]));
}

/** A zip entry's Unix mode: a symlink, a folder or a plain file. */
function entryMode(entry: Entry): number {
  if (entry.link !== undefined) return 0o120777;
  return entry.name.endsWith("/") ? 0o040755 : 0o100644;
}

/** `entries` as a stored zip, the xcframework's and the Windows asset's format (a link's target is its data). */
function zip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.link ?? entry.data ?? "");
    const mode = entryMode(entry);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A universal (fat) library holding an x86_64 and an arm64 `ar`, as the xcframework's macOS slice does. */
function fatLibrary(arm64: string, x86: string): Buffer {
  const header = Buffer.alloc(8 + 2 * 20);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(2, 4);
  const slices = [Buffer.from(x86), Buffer.from(arm64)];
  const types = [0x01000007, 0x0100000c];
  let offset = header.length;
  for (const [index, slice] of slices.entries()) {
    header.writeUInt32BE(types[index] ?? 0, 8 + index * 20);
    header.writeUInt32BE(offset, 8 + index * 20 + 8);
    header.writeUInt32BE(slice.length, 8 + index * 20 + 12);
    offset += slice.length;
  }
  return Buffer.concat([header, ...slices]);
}

/** The Windows asset's shape: MinGW archives named `<name>.lib` under `lib/`. */
const WINDOWS_GOOD: Entry[] = [
  { name: "lib/" },
  { name: "lib/colyseus.lib", data: LIBRARY },
  { name: "lib/wslay.lib", data: LIBRARY },
];

/** Every file and folder under `root`, `/`-separated and sorted, with each file's bytes. */
async function snapshot(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    found.push(entry.isFile() ? `${rel}=${(await readFile(full)).toString("hex")}` : `${rel}/`);
  }
  return found.sort();
}

/** A destination that already holds an installed triple, so a refusal can be seen to leave it alone. */
async function preparedDest(): Promise<{ parent: string; dest: string; before: string[] }> {
  const parent = await tmpDir("colyseus-dest-");
  const dest = path.join(parent, "tools", "colyseus");
  await mkdir(path.join(dest, ColyseusTriple.Windows), { recursive: true });
  await writeFile(path.join(dest, ColyseusTriple.Windows, "libcolyseus.a"), `${AR}older`);
  return { parent, dest, before: await snapshot(parent) };
}

/** The refusal's typed problem, or a failure naming what was thrown instead. */
async function problemOf(work: Promise<unknown>): Promise<ToolchainProblem> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ToolchainError) return error.problem;
    throw error;
  }
  assert.fail("expected a ToolchainError");
}

// ---------- the hostile table ----------

/** Paths a climbing or absolute entry would land on if the unpacker wrote it. */
const ESCAPE_NAME = `genex-colyseus-escape-${process.pid}`;

const HOSTILE: Array<{
  name: string;
  format: ArchiveFormat;
  into: string;
  body: () => Buffer;
  problem: ToolchainProblem;
}> = [
  {
    name: "a tar member that climbs out with ..",
    format: ArchiveFormat.TarGz,
    into: "linux",
    body: () =>
      tarGz([
        { name: "./lib/libcolyseus.a", data: LIBRARY },
        { name: `../../../${ESCAPE_NAME}`, data: "x" },
      ]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "a zip member that climbs out with ..",
    format: ArchiveFormat.Zip,
    into: "windows",
    body: () => zip([...WINDOWS_GOOD, { name: `../${ESCAPE_NAME}`, data: "x" }]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "an absolute tar member",
    format: ArchiveFormat.TarGz,
    into: "linux",
    body: () =>
      tarGz([
        { name: "./lib/libcolyseus.a", data: LIBRARY },
        { name: path.join(os.tmpdir(), ESCAPE_NAME), data: "x" },
      ]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "an absolute zip member",
    format: ArchiveFormat.Zip,
    into: "windows",
    body: () => zip([...WINDOWS_GOOD, { name: path.join(os.tmpdir(), ESCAPE_NAME), data: "x" }]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "a symlink member pointing out of the archive",
    format: ArchiveFormat.TarGz,
    into: "linux",
    body: () => tarGz([{ name: "./lib/" }, { name: "./lib/libcolyseus.a", link: "/etc/hosts" }]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "a symlink member that stays inside (the core library as a link to a companion)",
    format: ArchiveFormat.Zip,
    into: "windows",
    body: () =>
      zip([
        { name: "lib/" },
        { name: "lib/wslay.lib", data: LIBRARY },
        { name: "lib/colyseus.lib", link: "wslay.lib" },
      ]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "a slice folder that is a symlink",
    format: ArchiveFormat.TarGz,
    into: "linux",
    body: () =>
      tarGz([{ name: "./real/" }, { name: "./real/libcolyseus.a", data: LIBRARY }, { name: "./lib", link: "real" }]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "a hard link member",
    format: ArchiveFormat.TarGz,
    into: "linux",
    body: () =>
      tarGz([
        { name: "./lib/libwslay.a", data: LIBRARY },
        { name: "./lib/libcolyseus.a", hard: "./lib/libwslay.a" },
      ]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "an entry larger than the cap",
    format: ArchiveFormat.TarGz,
    into: "linux",
    body: () =>
      tarGz([
        { name: "./lib/libcolyseus.a", data: Buffer.concat([Buffer.from(AR), Buffer.alloc(COLYSEUS_ENTRY_BYTES_MAX)]) },
      ]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "an archive without the core library (the slice missing)",
    format: ArchiveFormat.Zip,
    into: "windows",
    body: () => zip([{ name: "lib/" }, { name: "lib/wslay.lib", data: LIBRARY }]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "an archive with no lib folder at all",
    format: ArchiveFormat.Zip,
    into: "windows",
    body: () => zip([{ name: "README.md", data: "hello" }]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "a core library that is not a static library",
    format: ArchiveFormat.TarGz,
    into: "linux",
    body: () => tarGz([{ name: "./lib/libcolyseus.a", data: "#!/bin/sh\necho hi\n" }]),
    problem: ToolchainProblem.Archive,
  },
  {
    name: "a universal library with no arm64 slice",
    format: ArchiveFormat.Zip,
    into: "apple",
    body: () => {
      const fat = fatLibrary(LIBRARY, LIBRARY);
      fat.writeUInt32BE(0x01000007, 8 + 20);
      return zip([
        { name: "Colyseus.xcframework/macos-arm64_x86_64/libcolyseus.a", data: fat },
        { name: "Colyseus.xcframework/ios-arm64/libcolyseus.a", data: LIBRARY },
        { name: "Colyseus.xcframework/ios-arm64_x86_64-simulator/libcolyseus.a", data: LIBRARY },
      ]);
    },
    problem: ToolchainProblem.Archive,
  },
  {
    name: "an xcframework missing its Simulator slice",
    format: ArchiveFormat.Zip,
    into: "apple",
    body: () =>
      zip([
        { name: "Colyseus.xcframework/macos-arm64_x86_64/libcolyseus.a", data: LIBRARY },
        { name: "Colyseus.xcframework/ios-arm64/libcolyseus.a", data: LIBRARY },
      ]),
    problem: ToolchainProblem.Archive,
  },
];

describe("a hostile libcolyseus archive installs nothing", () => {
  for (const row of HOSTILE) {
    it(`refuses ${row.name}`, async () => {
      const { parent, dest, before } = await preparedDest();
      const archive = path.join(await tmpDir("colyseus-archive-"), `asset.${row.format}`);
      await writeFile(archive, row.body());
      assert.equal(await problemOf(installColyseusArchive(archive, row.format, row.into, dest)), row.problem);
      assert.deepEqual(await snapshot(parent), before, "the destination and its folder are as they were");
      assert.equal(existsSync(path.join(os.tmpdir(), ESCAPE_NAME)), false);
      assert.equal(existsSync(path.join(parent, ESCAPE_NAME)), false);
    });
  }

  for (const [name, mutate] of [
    [
      "a sha mismatch",
      (bytes: Buffer) => Buffer.concat([bytes.subarray(0, -1), Buffer.from([(bytes.at(-1) ?? 0) ^ 1])]),
    ],
    ["a size mismatch", (bytes: Buffer) => Buffer.concat([bytes, Buffer.from("x")])],
  ] as const) {
    it(`refuses ${name} against the pin before reading an entry`, async () => {
      const { parent, dest, before } = await preparedDest();
      const pin = COLYSEUS_ASSETS[ColyseusAsset.WindowsX64];
      // Same size as the pin, but not its bytes: the size row adds one byte to it.
      const body = Buffer.alloc(pin.bytes);
      zip(WINDOWS_GOOD).copy(body);
      const archive = path.join(await tmpDir("colyseus-pin-"), ColyseusAsset.WindowsX64);
      await writeFile(archive, mutate(body));
      assert.equal(
        await problemOf(installColyseusAsset(archive, ColyseusAsset.WindowsX64, dest)),
        ToolchainProblem.Integrity,
      );
      assert.deepEqual(await snapshot(parent), before);
    });
  }

  it("never lays out the source tarball as a prebuilt", async () => {
    const { dest } = await preparedDest();
    assert.equal(
      await problemOf(installColyseusAsset("/nonexistent", ColyseusAsset.Source, dest)),
      ToolchainProblem.Archive,
    );
  });
});

describe("a pinned asset lays out one folder per triple", () => {
  it("renames the MinGW zip's <name>.lib to lib<name>.a for the gnullvm link", async () => {
    const { dest } = await preparedDest();
    const archive = path.join(await tmpDir("colyseus-win-"), "windows.zip");
    await writeFile(archive, zip(WINDOWS_GOOD));
    assert.deepEqual(await installColyseusArchive(archive, ArchiveFormat.Zip, "windows", dest), [
      ColyseusTriple.Windows,
    ]);
    const folder = path.join(dest, ColyseusTriple.Windows);
    assert.deepEqual((await readdir(folder)).sort(), ["libcolyseus.a", "libwslay.a"]);
    assert.equal(await readFile(path.join(folder, "libcolyseus.a"), "latin1"), LIBRARY);
    assert.equal((await lstat(path.join(folder, "libcolyseus.a"))).mode & 0o777, 0o644);
  });

  it("takes the Linux tarball's lib/ as shipped", async () => {
    const { dest } = await preparedDest();
    const archive = path.join(await tmpDir("colyseus-linux-"), "linux.tar.gz");
    await writeFile(
      archive,
      tarGz([{ name: "./" }, { name: "./lib/" }, { name: "./lib/libcolyseus.a", data: LIBRARY }]),
    );
    assert.deepEqual(await installColyseusArchive(archive, ArchiveFormat.TarGz, "linux", dest), [ColyseusTriple.Linux]);
    assert.deepEqual(await readdir(path.join(dest, ColyseusTriple.Linux)), ["libcolyseus.a"]);
  });

  it("takes the xcframework's three Apple slices, each universal library thinned to arm64 (rustc reads no fat archive)", async () => {
    const { dest } = await preparedDest();
    const archive = path.join(await tmpDir("colyseus-xc-"), "xc.zip");
    const arm = `${AR}arm64`;
    await writeFile(
      archive,
      zip([
        { name: "Colyseus.xcframework/macos-arm64_x86_64/libcolyseus.a", data: fatLibrary(arm, `${AR}x86_64`) },
        { name: "Colyseus.xcframework/ios-arm64/libcolyseus.a", data: arm },
        { name: "Colyseus.xcframework/ios-arm64_x86_64-simulator/libcolyseus.a", data: fatLibrary(arm, `${AR}x86_64`) },
        { name: "Colyseus.xcframework/tvos-arm64/libcolyseus.a", data: arm },
      ]),
    );
    const triples = await installColyseusArchive(archive, ArchiveFormat.Zip, "apple", dest);
    assert.deepEqual(triples, [ColyseusTriple.Mac, ColyseusTriple.Ios, ColyseusTriple.IosSim]);
    for (const triple of triples) assert.equal(await readFile(path.join(dest, triple, "libcolyseus.a"), "latin1"), arm);
    assert.equal(thinToArm64(Buffer.from(arm))?.toString("latin1"), arm);
  });
});

describe("the lane names each native triple's store folder", () => {
  it("a fixture store resolves a lib folder per native triple of this host's entry", async () => {
    const store = await tmpDir("colyseus-store-");
    const component = colyseusComponentFolder(store, ToolchainHost.MacArm64);
    assert.ok(component !== null);
    assert.ok(component.startsWith(path.join(store, ToolchainId.Colyseus, "0.18.10-")));
    const entry = manifestEntry(ToolchainId.Colyseus, ToolchainHost.MacArm64);
    assert.ok(entry);
    const probed = colyseusProbeFiles(entry);
    const prebuilt = [
      ColyseusTriple.Mac,
      ColyseusTriple.Ios,
      ColyseusTriple.IosSim,
      ColyseusTriple.Linux,
      ColyseusTriple.Windows,
    ];
    assert.deepEqual(
      probed,
      prebuilt.map((triple) => `lib/${triple}/libcolyseus.a`),
    );
    for (const file of probed) {
      await mkdir(path.dirname(path.join(component, file)), { recursive: true });
      await writeFile(path.join(component, file), LIBRARY);
    }
    for (const triple of prebuilt) {
      assert.deepEqual(await resolveColyseusLibDir(component, ToolchainHost.MacArm64, triple), {
        ok: true,
        dir: path.join(component, "lib", triple),
      });
    }
    const android = await resolveColyseusLibDir(component, ToolchainHost.MacArm64, ColyseusTriple.Android);
    assert.equal(android.ok ? null : android.refusal, ColyseusRefusal.NotInstalled);
  });

  it("a Linux host's entry serves Linux and Windows only (no xcframework download)", () => {
    const entry = manifestEntry(ToolchainId.Colyseus, ToolchainHost.LinuxX64);
    assert.ok(entry);
    assert.deepEqual(
      colyseusProbeFiles(entry),
      [ColyseusTriple.Linux, ColyseusTriple.Windows].map((t) => `lib/${t}/libcolyseus.a`),
    );
  });

  it("a host with no pinned component is refused colyseus-not-pinned, and its builds name a folder that is never made", async () => {
    assert.equal(colyseusComponentFolder("/store", ToolchainHost.WindowsX64), null);
    assert.equal(colyseusComponentFolder("/store", null), null);
    const refused = await resolveColyseusLibDir(null, ToolchainHost.WindowsX64, ColyseusTriple.Windows);
    assert.equal(refused.ok ? null : refused.refusal, ColyseusRefusal.NotPinned);
    assert.deepEqual(colyseusBuildEnv(null, "/bin/b", ColyseusTriple.Mac), {
      [COLYSEUS_LIB_DIR_ENV]: path.join("/bin/b", COLYSEUS_ABSENT_FOLDER),
    });
  });

  it("every native triple names a folder; a browser build links nothing", () => {
    for (const triple of Object.values(ColyseusTriple)) {
      assert.deepEqual(colyseusBuildEnv("/c", "/b", triple), {
        [COLYSEUS_LIB_DIR_ENV]: path.join("/c", "lib", triple),
      });
    }
    assert.deepEqual(colyseusBuildEnv("/c", "/b", "wasm32-unknown-unknown"), {});
  });

  it("Live builds of a [net] game need no Colyseus component; only a [net] export does", () => {
    const live = STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu];
    const netIds: readonly string[] = [ToolchainId.Colyseus, ToolchainId.ColyseusSource];
    for (const ids of Object.values(live))
      assert.equal(
        ids.some((id: string) => netIds.includes(id)),
        false,
      );
    assert.deepEqual(RUST_NET_COMPONENTS.web, []);
    assert.deepEqual(RUST_NET_COMPONENTS.android, [ToolchainId.ColyseusSource]);
    for (const target of ["macos", "ios", "windows", "linux"] as const) {
      assert.deepEqual(RUST_NET_COMPONENTS[target], [ToolchainId.Colyseus]);
    }
  });
});

describe("a [net] export's Windows imports", () => {
  const relay = writePe({ imports: ["KERNEL32.dll", "WS2_32.dll", "CRYPT32.dll", "ADVAPI32.dll", "bcrypt.dll"] }).bytes;

  it("refuses WS2_32.dll and CRYPT32.dll for every other game", () => {
    const admitted = admitRustPe(relay);
    assert.equal(admitted.ok, false);
    for (const dll of ["WS2_32.dll", "CRYPT32.dll"]) {
      assert.equal(admitRustPe(writePe({ imports: ["KERNEL32.dll", dll] }).bytes).ok, false, dll);
    }
  });

  it("admits the relay client's imports for a [net] export", () => {
    assert.equal(admitRustPe(relay, { network: true }).ok, true);
    assert.deepEqual([...RUST_WINDOWS_NET_DLLS].sort(), ["crypt32.dll", "ws2_32.dll"]);
  });

  it("still refuses an unlisted import for a [net] export", () => {
    for (const dll of ["WININET.dll", "winhttp.dll", "libwinpthread-1.dll"]) {
      assert.equal(admitRustPe(writePe({ imports: ["KERNEL32.dll", dll] }).bytes, { network: true }).ok, false, dll);
    }
  });
});

// ---------- the real assets ----------

/** The dev toolchain folder `rust-env.ts` uses. */
const TOOLCHAIN =
  process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(import.meta.dirname, "..", "..", ".studio-dev", "spike-toolchain");
const PREBUILT_ASSETS = [ColyseusAsset.Xcframework, ColyseusAsset.LinuxX64, ColyseusAsset.WindowsX64] as const;
const downloaded = PREBUILT_ASSETS.every((asset) => existsSync(path.join(TOOLCHAIN, "downloads", asset)));

/** The skip the real row takes without the downloads, or none; `GENEX_REQUIRE_TOOLCHAINS=1` fails instead. */
function realRow(): { skip?: string } {
  if (downloaded) return {};
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1")
    throw new Error("GENEX_REQUIRE_TOOLCHAINS=1: the Colyseus assets absent");
  return { skip: "not run: setup-toolchain.sh --with colyseus has not downloaded the assets" };
}

describe("the real pinned assets", () => {
  it("each matches its pin and lays out every prebuilt triple", realRow(), async () => {
    const dest = path.join(await tmpDir("colyseus-real-"), "colyseus");
    const triples: ColyseusTriple[] = [];
    for (const asset of PREBUILT_ASSETS) {
      triples.push(...(await installColyseusAsset(path.join(TOOLCHAIN, "downloads", asset), asset, dest)));
    }
    assert.deepEqual(
      triples.sort(),
      Object.values(ColyseusTriple)
        .filter((t) => t !== ColyseusTriple.Android)
        .sort(),
    );
    for (const triple of triples) {
      const core = await readFile(path.join(dest, triple, "libcolyseus.a"));
      assert.equal(core.subarray(0, AR.length).toString("latin1"), AR, triple);
    }
    assert.ok((await readdir(path.join(dest, ColyseusTriple.Linux))).length >= 10, "the Linux asset's companions");
  });
});
