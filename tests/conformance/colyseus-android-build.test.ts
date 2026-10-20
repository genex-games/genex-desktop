/**
 * MP-1b, Android's libcolyseus built from the pinned source (owner decision G12): the build
 * inputs the store pins beside the source tarball (zig 0.15.2 per host, upstream's build.zig
 * refusing any other zig, and the zig_msgpack archive its build.zig.zon names), their hostile
 * table, and the offline build itself (`toolchain-store/colyseus-android.ts`).
 *
 * The hostile table hands the input installer archives that climb, name absolute paths, carry a
 * link the pin does not list, a hard link, an oversized entry or too much in all, or fail their
 * pin, and asserts each installs nothing and writes nothing outside its folder. The build rows
 * run a stand-in for zig (the injected `run`): two equal builds lay out `lib/<triple>/`; two that
 * differ refuse and name the differing members; a link, a non-library or a missing core refuses;
 * an NDK that is not the pinned revision refuses before anything runs. The request itself reaches
 * no network and writes only its work folder.
 *
 * The real row checks the downloaded inputs against their pins (`GENEX_COLYSEUS_ANDROID_DOWNLOADS`,
 * default `<toolchain>/downloads`); it skips without them, and `GENEX_REQUIRE_COLYSEUS_ANDROID=1`
 * turns the skip into a failure. Nothing here launches a device.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ANDROID_PINS,
  ArchiveFormat,
  ColyseusTriple,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  ToolchainProblem,
} from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import {
  type BuildArchiveSpec,
  COLYSEUS_BUILD_INPUTS,
  COLYSEUS_ZIG_VERSION,
  ColyseusBuildInput,
  buildColyseusAndroid,
  colyseusBuildInputs,
  installBuildArchive,
  installColyseusBuildInput,
  verifyColyseusBuildInput,
  ZIG_MSGPACK_PACKAGE,
} from "../../src/substrate/toolchain-store/colyseus-android.ts";
import { manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { tarGz } from "../helpers/tar-archive.ts";
import { tmpDir } from "../helpers/tmp.ts";

// ---------- helpers ----------

/** Every file and folder under `root`, `/`-separated and sorted, with each file's bytes (a link as its target). */
async function snapshot(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) found.push(`${rel}->link`);
    else found.push(entry.isFile() ? `${rel}=${(await readFile(full)).toString("hex")}` : `${rel}/`);
  }
  return found.sort();
}

/** The refusal's typed problem and message, or a failure naming what was thrown instead. */
async function refusalOf(work: Promise<unknown>): Promise<{ problem: ToolchainProblem; message: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ToolchainError) return { problem: error.problem, message: error.message };
    throw error;
  }
  assert.fail("expected a ToolchainError");
}

/** A GNU `ar` archive of `members` (each name under 16 bytes), as zig's archiver writes one. */
function arArchive(members: ReadonlyArray<readonly [string, string]>): Buffer {
  const parts: Buffer[] = [Buffer.from("!<arch>\n", "latin1")];
  for (const [name, data] of members) {
    const body = Buffer.from(data);
    const header =
      `${name}/`.padEnd(16) +
      "0".padEnd(12) +
      "0".padEnd(6) +
      "0".padEnd(6) +
      "644".padEnd(8) +
      String(body.length).padEnd(10) +
      "`\n";
    parts.push(Buffer.from(header, "latin1"), body, Buffer.alloc(body.length % 2));
  }
  return Buffer.concat(parts);
}

// ---------- the pins ----------

describe("the Android build inputs are pinned in the store beside the source", () => {
  it("upstream's zig is 0.15.2 (its build.zig refuses any other); the store's own zig stays apart", () => {
    assert.equal(COLYSEUS_ZIG_VERSION, "0.15.2");
    for (const input of [ColyseusBuildInput.ZigMacArm64, ColyseusBuildInput.ZigLinuxX64]) {
      assert.match(COLYSEUS_BUILD_INPUTS[input].url, /^https:\/\/ziglang\.org\/download\/0\.15\.2\//);
    }
  });

  it("zig_msgpack unpacks into the folder build.zig.zon's package hash names, for zig build --system", () => {
    assert.equal(ZIG_MSGPACK_PACKAGE, "zig_msgpack-0.0.14-evvueGolBQBs_m726tBf4ISJQqC926AM96EtxZy9LUaI");
    assert.equal(COLYSEUS_BUILD_INPUTS[ColyseusBuildInput.ZigMsgpack].into, `packages/${ZIG_MSGPACK_PACKAGE}`);
  });

  for (const host of [ToolchainHost.MacArm64, ToolchainHost.LinuxX64]) {
    it(`the ${host} colyseus-source entry is the source, that host's zig and zig_msgpack, each at its pin`, () => {
      const entry = manifestEntry(ToolchainId.ColyseusSource, host);
      const inputs = colyseusBuildInputs(host);
      assert.ok(entry && inputs);
      assert.equal(entry.host, host);
      assert.deepEqual(
        entry.archives.map(({ url, bytes, sha256, format, strip, into }) => ({
          url,
          bytes,
          sha256,
          format,
          strip,
          into,
        })),
        inputs.map((input) => {
          const { url, bytes, sha256, format, strip, into } = COLYSEUS_BUILD_INPUTS[input];
          return { url, bytes, sha256, format, strip, into };
        }),
      );
    });
  }

  it("a host with no pinned zig has no Android build", () => {
    assert.equal(colyseusBuildInputs(ToolchainHost.WindowsX64), null);
  });
});

// ---------- the hostile table ----------

const ESCAPE_NAME = `genex-colyseus-android-escape-${process.pid}`;
const SMALL: BuildArchiveSpec = {
  format: ArchiveFormat.TarGz,
  strip: 1,
  into: "source",
  entryBytesMax: 1024,
  unpackedBytesMax: 4096,
  links: { "third_party/uthash/include": "src" },
};

const HOSTILE: Array<{ name: string; entries: Parameters<typeof tarGz>[0] }> = [
  {
    name: "a member that climbs out with ..",
    entries: [
      { name: "top/build.zig", data: "x" },
      { name: `../../${ESCAPE_NAME}`, data: "x" },
    ],
  },
  {
    name: "an absolute member",
    entries: [
      { name: "top/build.zig", data: "x" },
      { name: path.join(os.tmpdir(), ESCAPE_NAME), data: "x" },
    ],
  },
  { name: "a symlink out of the archive", entries: [{ name: "top/build.zig", link: "/etc/hosts" }] },
  {
    name: "a symlink the pin does not list, though it stays inside",
    entries: [
      { name: "top/a.c", data: "x" },
      { name: "top/b.c", link: "a.c" },
    ],
  },
  {
    name: "the listed link pointing somewhere else",
    entries: [
      { name: "top/third_party/uthash/src/uthash.h", data: "x" },
      { name: "top/third_party/uthash/include", link: "../../.." },
    ],
  },
  {
    name: "a hard link",
    entries: [
      { name: "top/a.c", data: "x" },
      { name: "top/b.c", hard: "top/a.c" },
    ],
  },
  { name: "an entry larger than the cap", entries: [{ name: "top/big.c", data: Buffer.alloc(1025) }] },
  {
    name: "more than the cap in all",
    entries: Array.from({ length: 5 }, (_, index) => ({ name: `top/part${index}.c`, data: Buffer.alloc(1000) })),
  },
];

/** A component that already holds an installed source, so a refusal can be seen to leave it alone. */
async function preparedComponent(): Promise<{ parent: string; component: string; before: string[] }> {
  const parent = await tmpDir("colyseus-android-component-");
  const component = path.join(parent, "colyseus-source");
  await mkdir(path.join(component, "source"), { recursive: true });
  await writeFile(path.join(component, "source", "build.zig"), "older");
  return { parent, component, before: await snapshot(parent) };
}

describe("a hostile build input installs nothing", () => {
  for (const row of HOSTILE) {
    it(`refuses ${row.name}`, async () => {
      const { parent, component, before } = await preparedComponent();
      const archive = path.join(await tmpDir("colyseus-android-archive-"), "input.tar.gz");
      await writeFile(archive, tarGz(row.entries));
      const { problem } = await refusalOf(installBuildArchive(archive, SMALL, component));
      assert.equal(problem, ToolchainProblem.Archive);
      assert.deepEqual(await snapshot(parent), before, "the component and its folder are as they were");
      assert.equal(existsSync(path.join(os.tmpdir(), ESCAPE_NAME)), false);
      assert.equal(existsSync(path.join(parent, ESCAPE_NAME)), false);
    });
  }

  for (const [name, grow] of [
    ["a sha mismatch", 0],
    ["a size mismatch", 1],
  ] as const) {
    it(`refuses ${name} against the pin before reading an entry`, async () => {
      const { parent, component, before } = await preparedComponent();
      const pin = COLYSEUS_BUILD_INPUTS[ColyseusBuildInput.ZigMsgpack];
      const body = Buffer.alloc(pin.bytes + grow);
      tarGz([{ name: "top/build.zig", data: "x" }]).copy(body);
      const archive = path.join(await tmpDir("colyseus-android-pin-"), ColyseusBuildInput.ZigMsgpack);
      await writeFile(archive, body);
      const { problem } = await refusalOf(installColyseusBuildInput(archive, ColyseusBuildInput.ZigMsgpack, component));
      assert.equal(problem, ToolchainProblem.Integrity);
      assert.deepEqual(await snapshot(parent), before);
    });
  }

  it("installs a good input whole into its folder, with the one link the pin lists, replacing what was there", async () => {
    const { component } = await preparedComponent();
    const archive = path.join(await tmpDir("colyseus-android-good-"), "input.tar.gz");
    await writeFile(
      archive,
      tarGz([
        { name: "top/" },
        { name: "top/build.zig", data: "pub fn build() void {}" },
        { name: "top/third_party/uthash/src/uthash.h", data: "#define UTHASH" },
        { name: "top/third_party/uthash/include", link: "src" },
      ]),
    );
    await installBuildArchive(archive, SMALL, component);
    assert.deepEqual(await snapshot(component), [
      "source/",
      `source/build.zig=${Buffer.from("pub fn build() void {}").toString("hex")}`,
      "source/third_party/",
      "source/third_party/uthash/",
      "source/third_party/uthash/include->link",
      "source/third_party/uthash/src/",
      `source/third_party/uthash/src/uthash.h=${Buffer.from("#define UTHASH").toString("hex")}`,
    ]);
    assert.deepEqual(
      (await readdir(path.dirname(component))).filter((name) => name.includes("staging")),
      [],
      "no staging folder is left behind",
    );
  });
});

// ---------- the build ----------

/** The libraries a stand-in build writes: the core and two companions, each a real `ar` archive. */
const GOOD_LIBS: Record<string, Buffer> = {
  "libcolyseus.a": arArchive([
    ["client.o", "client"],
    ["room.o", "room"],
  ]),
  "libwslay.a": arArchive([["wslay.o", "wslay"]]),
  "libmbedtls.a": arArchive([["ssl.o", "ssl"]]),
};

/** A fake installed component (source, zig, the package) and a fake NDK at `revision`. */
async function buildFixture(revision: string = ANDROID_PINS.ndk) {
  const root = await tmpDir("colyseus-android-build-");
  const component = path.join(root, "colyseus-source");
  await mkdir(path.join(component, "source", "tests", "schema"), { recursive: true });
  await writeFile(path.join(component, "source", "build.zig"), "pub const build = 0;");
  await writeFile(path.join(component, "source", "tests", "schema", "test_room_state.h"), "// schema");
  await mkdir(path.join(component, "zig"), { recursive: true });
  await writeFile(path.join(component, "zig", "zig"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(path.join(component, "packages", ZIG_MSGPACK_PACKAGE), { recursive: true });
  await writeFile(path.join(component, "packages", ZIG_MSGPACK_PACKAGE, "build.zig.zon"), ".{}");
  const ndk = path.join(root, "ndk");
  await mkdir(ndk, { recursive: true });
  await writeFile(path.join(ndk, "source.properties"), `Pkg.Desc = Android NDK\nPkg.Revision = ${revision}\n`);
  const dest = path.join(root, "tools", "colyseus");
  await mkdir(path.join(dest, ColyseusTriple.Linux), { recursive: true });
  await writeFile(path.join(dest, ColyseusTriple.Linux, "libcolyseus.a"), "!<arch>\nolder");
  return { root, component, ndk, dest, work: path.join(root, "work") };
}

type Writer = (out: string, round: number) => Promise<void>;

/** A stand-in for zig: records each request and writes `writer`'s libraries under the request's `--prefix`. */
function fakeZig(writer: Writer, code = 0) {
  const requests: RunRequest[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    requests.push(request);
    const prefix = /'--prefix' '([^']+)'/.exec(request.command)?.[1];
    assert.ok(prefix, request.command);
    if (code === 0) await writer(path.join(prefix, "lib"), requests.length - 1);
    return {
      code,
      signal: null,
      stdout: "",
      stderr: code === 0 ? "" : "error: the build failed",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      sandboxed: true,
      command: request.command,
      cwd: request.cwd,
    };
  };
  return { requests, run };
}

/** Writes `libs` into `out`. */
async function writeLibs(out: string, libs: Record<string, Buffer>): Promise<void> {
  await mkdir(out, { recursive: true });
  for (const [name, bytes] of Object.entries(libs)) await writeFile(path.join(out, name), bytes);
}

describe("Android's libcolyseus is built twice from the pinned source, offline, and only a byte-equal pair is laid out", () => {
  it("two equal builds lay out lib/<triple>/ with the core and its companions", async () => {
    const fixture = await buildFixture();
    const zig = fakeZig((out) => writeLibs(out, GOOD_LIBS));
    const built = await buildColyseusAndroid(fixture, { run: zig.run });
    assert.equal(built.triple, ColyseusTriple.Android);
    assert.deepEqual(built.libraries, ["libcolyseus.a", "libwslay.a", "libmbedtls.a"]);
    const folder = path.join(fixture.dest, ColyseusTriple.Android);
    assert.deepEqual((await readdir(folder)).sort(), ["libcolyseus.a", "libmbedtls.a", "libwslay.a"]);
    assert.deepEqual(await readFile(path.join(folder, "libcolyseus.a")), GOOD_LIBS["libcolyseus.a"]);
    assert.equal(
      await readFile(path.join(fixture.dest, ColyseusTriple.Linux, "libcolyseus.a"), "latin1"),
      "!<arch>\nolder",
      "another triple's folder is untouched",
    );
    assert.equal(zig.requests.length, 2);
  });

  it("each build reaches no network, writes only its work folder and runs zig build --system for the Android target", async () => {
    const fixture = await buildFixture();
    const zig = fakeZig((out) => writeLibs(out, GOOD_LIBS));
    await buildColyseusAndroid(fixture, { run: zig.run });
    for (const request of zig.requests) {
      assert.deepEqual(request.policy?.allowedDomains, []);
      assert.deepEqual(request.policy?.allowWrite, [fixture.work]);
      assert.match(request.command, /'--system' '[^']*packages'/);
      assert.match(request.command, /'-Dtarget=aarch64-linux-android'/);
      assert.match(request.command, new RegExp(`'-Dandroid-ndk=${fixture.ndk}'`));
      assert.match(request.command, /'-Doptimize=ReleaseFast'/);
      assert.match(request.command, /'-Dstrip=true'/, "the Zig modules' random builtin paths are stripped");
      assert.ok(request.cwd.startsWith(fixture.work), request.cwd);
      assert.doesNotMatch(request.env?.PATH ?? "", /\/usr\/bin/, "xcrun stays off PATH");
    }
    assert.equal(zig.requests[0]?.command, zig.requests[1]?.command, "both builds run at the same paths");
  });
});

describe("an Android build that is not reproducible, or not libcolyseus, lays out nothing", () => {
  it("refuses two builds that differ, naming the archive and its differing members, and lays out nothing", async () => {
    const fixture = await buildFixture();
    const before = await snapshot(fixture.dest);
    const zig = fakeZig((out, round) =>
      writeLibs(out, {
        ...GOOD_LIBS,
        "libcolyseus.a": arArchive([
          ["client.o", round === 0 ? "client" : "client-2"],
          ["room.o", "room"],
        ]),
      }),
    );
    const { problem, message } = await refusalOf(buildColyseusAndroid(fixture, { run: zig.run }));
    assert.equal(problem, ToolchainProblem.Integrity);
    assert.match(message, /libcolyseus\.a/);
    assert.match(message, /client\.o/);
    assert.doesNotMatch(message, /room\.o/);
    assert.deepEqual(await snapshot(fixture.dest), before);
  });

  it("refuses two builds whose library sets differ", async () => {
    const fixture = await buildFixture();
    const zig = fakeZig((out, round) =>
      writeLibs(out, round === 0 ? GOOD_LIBS : { "libcolyseus.a": GOOD_LIBS["libcolyseus.a"] ?? Buffer.alloc(0) }),
    );
    const { problem, message } = await refusalOf(buildColyseusAndroid(fixture, { run: zig.run }));
    assert.equal(problem, ToolchainProblem.Integrity);
    assert.match(message, /libwslay\.a/);
  });

  const broken: Array<[string, Writer]> = [
    [
      "a core library that is a link",
      async (out) => {
        await writeLibs(out, { "libwslay.a": GOOD_LIBS["libwslay.a"] ?? Buffer.alloc(0) });
        await symlink(path.join(out, "libwslay.a"), path.join(out, "libcolyseus.a"));
      },
    ],
    [
      "a core library that is not a static library",
      (out) => writeLibs(out, { "libcolyseus.a": Buffer.from("#!/bin/sh\n") }),
    ],
    ["no core library", (out) => writeLibs(out, { "libwslay.a": GOOD_LIBS["libwslay.a"] ?? Buffer.alloc(0) })],
  ];
  for (const [name, writer] of broken) {
    it(`refuses ${name} and lays out nothing`, async () => {
      const fixture = await buildFixture();
      const before = await snapshot(fixture.dest);
      const { problem } = await refusalOf(buildColyseusAndroid(fixture, { run: fakeZig(writer).run }));
      assert.equal(problem, ToolchainProblem.Archive);
      assert.deepEqual(await snapshot(fixture.dest), before);
    });
  }

  it("refuses a build that fails, with zig's last words", async () => {
    const fixture = await buildFixture();
    const before = await snapshot(fixture.dest);
    const { message } = await refusalOf(buildColyseusAndroid(fixture, { run: fakeZig(async () => {}, 1).run }));
    assert.match(message, /the build failed/);
    assert.deepEqual(await snapshot(fixture.dest), before);
  });
});

describe("an Android build checks its inputs before anything runs", () => {
  it("refuses an NDK that is not the pinned revision before anything runs", async () => {
    const fixture = await buildFixture("27.1.12297006");
    const zig = fakeZig((out) => writeLibs(out, GOOD_LIBS));
    const { problem } = await refusalOf(buildColyseusAndroid(fixture, { run: zig.run }));
    assert.equal(problem, ToolchainProblem.Probe);
    assert.equal(zig.requests.length, 0);
  });

  it("refuses a component whose zig is a link before anything runs", async () => {
    const fixture = await buildFixture();
    const zigFile = path.join(fixture.component, "zig", "zig");
    await writeFile(path.join(fixture.root, "elsewhere"), "#!/bin/sh\n");
    await rm(zigFile);
    await symlink(path.join(fixture.root, "elsewhere"), zigFile);
    const zig = fakeZig((out) => writeLibs(out, GOOD_LIBS));
    const { problem } = await refusalOf(buildColyseusAndroid(fixture, { run: zig.run }));
    assert.equal(problem, ToolchainProblem.Archive);
    assert.equal(zig.requests.length, 0);
  });
});

// ---------- the real inputs ----------

/** The dev toolchain folder `rust-env.ts` uses. */
const TOOLCHAIN =
  process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(import.meta.dirname, "..", "..", ".studio-dev", "spike-toolchain");
const DOWNLOADS = process.env.GENEX_COLYSEUS_ANDROID_DOWNLOADS ?? path.join(TOOLCHAIN, "downloads");
const INPUTS = Object.values(ColyseusBuildInput);
const downloaded = INPUTS.every((input) => existsSync(path.join(DOWNLOADS, input)));

/** The skip the real row takes without the downloads, or none; `GENEX_REQUIRE_COLYSEUS_ANDROID=1` fails instead. */
function realRow(): { skip?: string } {
  if (downloaded) return {};
  if (process.env.GENEX_REQUIRE_COLYSEUS_ANDROID === "1")
    throw new Error("GENEX_REQUIRE_COLYSEUS_ANDROID=1: the Android build inputs absent");
  return { skip: "not run: the Android build inputs have not been downloaded" };
}

describe("the real build inputs", () => {
  it("each downloaded input matches its pin", realRow(), async () => {
    for (const input of INPUTS) await verifyColyseusBuildInput(path.join(DOWNLOADS, input), input);
  });
});
