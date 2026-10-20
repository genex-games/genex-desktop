/**
 * The manifest's pins against what was actually downloaded and built: raylib's tag archive by its
 * `SHA256SUMS` line, each Genex-built ANGLE by its folder's `manifest.json`. Every Genex build
 * bundles the pinned ANGLE for all three desktop targets (`native/angle/bundle-lock.json`), so its
 * entries are pinned artifacts the store installs from the app's own resources: never fetched,
 * never `not-hosted`. A local artifact the app does not bundle still has no download.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ToolchainService } from "../../src/main/core/toolchains.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  ArchiveFormat,
  missingFor,
  PrewarmState,
  type ToolchainEntry,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  type ToolchainLock,
  type ToolchainStatus,
  ToolchainError,
  ToolchainProblem,
  ToolchainUnhosted,
} from "../../src/shared/toolchain.ts";
import {
  entryDigest,
  entrySha12,
  isDownloadable,
  isPinned,
  isReleaseUrl,
  manifestEntry,
  RUST_MANIFEST,
  RUST_PARTS,
  releaseManifest,
  rustManifestOf,
  TOOLCHAIN_MANIFEST,
} from "../../src/substrate/toolchain-store/manifest.ts";
import { LINUX_VULKAN_FILE_PINS, LinuxRuntimeFile, LinuxVulkanFile } from "../../src/substrate/native-runtime-files.ts";
import { DEV_TOOL, type DevToolName, devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RAYLIB = {
  url: "https://github.com/raysan5/raylib/archive/refs/tags/6.0.tar.gz",
  bytes: 52_545_040,
  sha256: "2b3ee1e2120c7a0796b33062c7e9a694dd8a8caa56a96319ac8c8ecf54a90d0b",
};

/** Each ANGLE entry, the dev folder it was pinned from and its recorded manifest facts. */
const ANGLES: Array<{
  id: ToolchainId;
  tool: DevToolName;
  manifestSha256: string;
  manifestBytes: number;
  files: number;
  bytes: number;
}> = [
  {
    id: ToolchainId.AngleMac,
    tool: "angleMac",
    manifestSha256: "bcc4bb790a505e58c30b3586721ef7a63fe945df5103c4bca063a705714ba3f4",
    manifestBytes: 8_231,
    files: 28,
    bytes: 7_053_062,
  },
  {
    id: ToolchainId.AngleWindows,
    tool: "angleWindows",
    manifestSha256: "07e0f306c0bbf880c3ee73842e7e11969c70d7b71c4380f635b52e2bf51c70b2",
    manifestBytes: 6_480,
    files: 29,
    bytes: 11_994_569,
  },
  {
    id: ToolchainId.AngleLinux,
    tool: "angleLinux",
    manifestSha256: "5f3e2089b5b63e4774c984b06015eee652964f27eaf02982b2e74b285841fded",
    manifestBytes: 8_943,
    files: 40,
    bytes: 17_376_008,
  },
];

/** The Linux headers' sysroot `scripts/toolchains/linux-sysroot.ts` builds, and its recorded manifest facts. */
const LINUX_SYSROOT = {
  id: ToolchainId.LinuxSysroot,
  tool: "linuxSysroot",
  manifestSha256: "8031a635e0327caea1817221f933817bbd131217d316b0711c6da2a4fb2548c9",
  manifestBytes: 36_154,
  files: 215,
  bytes: 4_909_033,
} as const;

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A file's sha256, streamed (the raylib archive is 50 MB). */
async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function present(name: DevToolName): string {
  const found = devTool(name);
  if ("skip" in found) throw new Error(found.skip);
  return found.path;
}

function entryOf(id: ToolchainId): ToolchainEntry {
  const found = manifestEntry(id, ToolchainHost.MacArm64);
  assert.ok(found, id);
  return found;
}

describe("the raylib source pin", () => {
  it("is the tag's source archive, pinned and downloadable", () => {
    const raylib = entryOf(ToolchainId.RaylibSource);
    assert.deepEqual(raylib.archives, [
      { url: RAYLIB.url, bytes: RAYLIB.bytes, sha256: RAYLIB.sha256, format: ArchiveFormat.TarGz, strip: 1, into: "" },
    ]);
    assert.equal(raylib.local, undefined);
    assert.equal(isPinned(raylib), true);
    assert.equal(isDownloadable(raylib), true);
    assert.equal(entryDigest(raylib), RAYLIB.sha256);
    assert.equal(entrySha12(raylib), RAYLIB.sha256.slice(0, 12));
  });

  it("equals its SHA256SUMS line and the downloaded archive", needsTools("sha256sums", "raylibArchive"), async () => {
    const sums = await readFile(present("sha256sums"), "utf8");
    const name = path.basename(DEV_TOOL.raylibArchive);
    const line = sums.split("\n").find((row) => row.split(/\s+/)[1] === name);
    assert.ok(line, `SHA256SUMS records ${name}`);
    const [digest, , bytes, url] = line.split(/\s+/);
    const raylib = entryOf(ToolchainId.RaylibSource).archives[0];
    assert.ok(raylib);
    assert.deepEqual(
      { sha256: digest, bytes: Number(bytes), url },
      { sha256: raylib.sha256, bytes: raylib.bytes, url: raylib.url },
    );
    assert.equal(await fileSha256(present("raylibArchive")), raylib.sha256, "the archive on disk is the pinned one");
  });
});

describe("the ANGLE pins", () => {
  for (const angle of ANGLES) {
    it(`${angle.id} is bundled with the app: pinned by its manifest.json, no URL, installable from the app`, () => {
      const entry = entryOf(angle.id);
      assert.deepEqual(entry.archives, []);
      assert.deepEqual(entry.local, {
        manifestSha256: angle.manifestSha256,
        manifestBytes: angle.manifestBytes,
        files: angle.files,
        bytes: angle.bytes,
        reason: ToolchainUnhosted.NotPublished,
      });
      assert.equal(isPinned(entry), true, "its digest is recorded");
      assert.equal(isDownloadable(entry), true, "the store installs it from the app's resources");
      assert.equal(entryDigest(entry), angle.manifestSha256);
      assert.equal(entrySha12(entry), angle.manifestSha256.slice(0, 12));
    });

    it(`${angle.id} equals the sha256 of the cached folder's manifest.json`, needsTools(angle.tool), async () => {
      const folder = present(angle.tool);
      const manifest = await readFile(path.join(folder, "manifest.json"));
      assert.equal(sha256(manifest), angle.manifestSha256);
      assert.equal(manifest.length, angle.manifestBytes);
      const files: Record<string, { sha256: string; size: number }> = JSON.parse(manifest.toString("utf8")).files;
      const listed = Object.values(files);
      assert.equal(listed.length, angle.files);
      assert.equal(
        listed.reduce((sum, file) => sum + file.size, 0),
        angle.bytes,
      );
      // Every listed file is there with its size and digest: the pin covers the whole folder.
      for (const [rel, file] of Object.entries(files)) {
        const data = await readFile(path.join(folder, rel));
        assert.equal(data.length, file.size, rel);
        assert.equal(sha256(data), file.sha256, rel);
      }
      assert.ok((await readdir(folder)).includes("manifest.json"));
    });
  }

  it("no entry names a Genex download host that does not exist yet", () => {
    for (const entry of TOOLCHAIN_MANIFEST)
      for (const archive of entry.archives)
        assert.doesNotMatch(archive.url, /plugins\.genex\.games\/toolchains\/angle/, `${entry.id} ${entry.host}`);
  });
});

describe("the SwiftShader pin, split out of the Linux ANGLE artifact", () => {
  it("pins every software Vulkan file a Linux game ships, by sha256 and size", () => {
    assert.equal(ToolchainId.SwiftShaderLinux, "swiftshader-linux");
    assert.deepEqual(Object.keys(LINUX_VULKAN_FILE_PINS), Object.values(LinuxVulkanFile));
    for (const [name, pin] of Object.entries(LINUX_VULKAN_FILE_PINS)) {
      assert.match(pin.sha256, /^[0-9a-f]{64}$/, name);
      assert.ok(Number.isInteger(pin.size) && pin.size > 0, name);
    }
    assert.equal(
      LINUX_VULKAN_FILE_PINS[LinuxVulkanFile.SwiftShader].sha256,
      "45ce6204bf5a4fb80403b8a4765e6cc00cc6fe1dc2f11dfb3f860c29398557cb",
    );
    // The raylib Linux set still ships the same files inside ANGLE's.
    for (const name of Object.values(LinuxVulkanFile))
      assert.ok((Object.values(LinuxRuntimeFile) as string[]).includes(name), name);
  });

  it("equals the bytes the pinned Linux ANGLE build lists and holds", needsTools("angleLinux"), async () => {
    const folder = present("angleLinux");
    const files: Record<string, { sha256: string; size: number }> = JSON.parse(
      await readFile(path.join(folder, "manifest.json"), "utf8"),
    ).files;
    for (const [name, pin] of Object.entries(LINUX_VULKAN_FILE_PINS)) {
      assert.deepEqual(files[name], { sha256: pin.sha256, size: pin.size }, name);
      const data = await readFile(path.join(folder, name));
      assert.equal(data.length, pin.size, name);
      assert.equal(sha256(data), pin.sha256, name);
    }
  });
});

describe("the Linux sysroot pin", () => {
  it("pins the Linux manifest and deterministic archive while its download URL remains unpublished", () => {
    const entry = entryOf(LINUX_SYSROOT.id);
    assert.equal(entry.target, BuildTarget.Linux);
    assert.equal(entry.host, null);
    assert.deepEqual(entry.archives, []);
    assert.deepEqual(entry.local, {
      manifestSha256: LINUX_SYSROOT.manifestSha256,
      fetch: {
        url: null,
        sha256: "105406897b0ea242d6a928efc15503266c03eedd5d21e4355b8e71ff0ea0d97d",
        bytes: 1_639_754,
        format: ArchiveFormat.TarGz,
      },
      manifestBytes: LINUX_SYSROOT.manifestBytes,
      files: LINUX_SYSROOT.files,
      bytes: LINUX_SYSROOT.bytes,
      reason: ToolchainUnhosted.NotPublished,
    });
    assert.equal(isPinned(entry), true);
    assert.equal(isDownloadable(entry), true, "the unpublished sysroot is included with Genex");
    assert.equal(entrySha12(entry), LINUX_SYSROOT.manifestSha256.slice(0, 12));
    assert.equal(DEV_TOOL.linuxSysroot, `linux-sysroot-x64/${entrySha12(entry)}`, "the dev folder is named by the pin");
  });

  it(
    "equals the sha256 of the built folder's manifest.json, which lists every file it holds",
    needsTools(LINUX_SYSROOT.tool),
    async () => {
      const folder = present(LINUX_SYSROOT.tool);
      const manifest = await readFile(path.join(folder, "manifest.json"));
      assert.equal(sha256(manifest), LINUX_SYSROOT.manifestSha256);
      assert.equal(manifest.length, LINUX_SYSROOT.manifestBytes);
      const parsed = JSON.parse(manifest.toString("utf8"));
      assert.match(parsed.imageDigest, /^sha256:[0-9a-f]{64}$/, "the image is pinned by digest");
      const files: Record<string, { sha256: string; size: number }> = parsed.files;
      assert.equal(Object.keys(files).length, LINUX_SYSROOT.files);
      assert.equal(
        Object.values(files).reduce((sum, file) => sum + file.size, 0),
        LINUX_SYSROOT.bytes,
      );
      for (const [rel, file] of Object.entries(files)) {
        const data = await readFile(path.join(folder, rel));
        assert.equal(sha256(data), file.sha256, rel);
      }
      for (const rel of [
        "usr/include/X11/Xlib.h",
        "usr/include/wayland-client.h",
        "glfw-wayland/xdg-shell-client-protocol.h",
      ])
        assert.ok(rel in files, rel);
    },
  );
});

describe("pinned, downloadable and local entries", () => {
  const archive = {
    url: "https://example.invalid/a.tar.gz",
    bytes: 1,
    format: ArchiveFormat.TarGz,
    strip: 0,
    into: "",
  };
  const base = { id: ToolchainId.Ninja, version: "1", host: ToolchainHost.MacArm64, target: null, licence: "MIT" };
  const local = {
    manifestSha256: "a".repeat(64),
    manifestBytes: 10,
    files: 1,
    bytes: 1,
    reason: ToolchainUnhosted.NotPublished,
  };
  const rows: Array<{ name: string; entry: ToolchainEntry; pinned: boolean; downloadable: boolean }> = [
    {
      name: "a pinned archive",
      entry: { ...base, archives: [{ ...archive, sha256: "b".repeat(64) }] },
      pinned: true,
      downloadable: true,
    },
    {
      name: "an unpinned archive",
      entry: { ...base, archives: [{ ...archive, sha256: null }] },
      pinned: false,
      downloadable: false,
    },
    { name: "no archive at all", entry: { ...base, archives: [] }, pinned: false, downloadable: false },
    { name: "a local artifact", entry: { ...base, archives: [], local }, pinned: true, downloadable: false },
    {
      name: "a local artifact that also lists an archive",
      entry: { ...base, archives: [{ ...archive, sha256: "b".repeat(64) }], local },
      pinned: false,
      downloadable: false,
    },
  ];
  for (const row of rows)
    it(`${row.name}: pinned ${row.pinned}, downloadable ${row.downloadable}`, () => {
      assert.equal(isPinned(row.entry), row.pinned);
      assert.equal(isDownloadable(row.entry), row.downloadable);
    });

  it("a local artifact's digest is its manifest's", () => {
    assert.equal(entryDigest({ ...base, archives: [], local }), local.manifestSha256);
  });
});

describe("an install takes ANGLE from the app and never fetches it", () => {
  /** The service over an empty store, with every fetch recorded; nothing may reach the network. */
  async function service(installed: string[][]) {
    const store = await tmpDir("toolchain-pins-store-");
    const fetched: string[] = [];
    const lock = (entries: ToolchainLock["entries"]): ToolchainLock => ({
      version: 1,
      entries,
      digest: "c".repeat(64),
    });
    const tools = new ToolchainService({
      store,
      host: ToolchainHost.MacArm64,
      emit: () => {},
      run: async () => {
        throw new Error("nothing runs");
      },
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
      probeClt: async () => ({ present: true, version: null }),
      fetch: async (url) => {
        fetched.push(String(url));
        throw new Error("no network in this test");
      },
      ops: {
        installComponents: async (_store, entries) => {
          installed.push(entries.map((entry) => entry.id));
          return { phase: ToolchainInstallPhase.Installed, entry: null, completed: 0, total: 0, startedAt: "" };
        },
        readReceipts: async () => [],
        currentLock: async () => null,
        writeCurrentLock: async () => {},
        locateToolchain: async (_store, located) => ({
          ok: true,
          toolchain: { lock: located, cmake: "", ninja: "", emscripten: null, genexCmake: {} },
        }),
        lockOf: lock,
      },
    });
    return { tools, fetched };
  }

  const allComponents = [
    ToolchainId.Cmake,
    ToolchainId.Ninja,
    ToolchainId.Emsdk,
    ToolchainId.RaylibSource,
    ToolchainId.AngleMac,
    ToolchainId.Zig,
    ToolchainId.AngleWindows,
    ToolchainId.AngleLinux,
    ToolchainId.LinuxSysroot,
  ];

  it("asked for the Mac alone, it sets up all destinations with the bundled artifacts and fetches nothing itself", async () => {
    const installed: string[][] = [];
    const { tools, fetched } = await service(installed);
    const job = await tools.install([BuildTarget.Mac]);
    assert.equal(job.phase, ToolchainInstallPhase.Installed);
    assert.equal(job.problem, undefined, "never not-hosted");
    assert.equal(job.unavailable, undefined, "the Mac is not left out");
    assert.deepEqual(installed, [allComponents]);
    assert.deepEqual(fetched, []);
  });

  it("asked for Browser and Mac, the same complete C++ setup installs once", async () => {
    const installed: string[][] = [];
    const { tools, fetched } = await service(installed);
    const job = await tools.install([BuildTarget.Web, BuildTarget.Mac]);
    assert.equal(job.phase, ToolchainInstallPhase.Installed);
    assert.equal(job.unavailable, undefined);
    assert.deepEqual(installed, [allComponents]);
    assert.deepEqual(fetched, []);
  });

  it("the status names no ANGLE as unhosted, and the sheet lists every ANGLE with nothing to download", async () => {
    const { tools } = await service([]);
    const status = await tools.status();
    for (const angle of ANGLES)
      assert.ok(!status.unhosted?.some((item) => item.id === angle.id), `${angle.id} is not unhosted`);
    const plan = await tools.plan();
    for (const angle of ANGLES) {
      const listed = plan.downloads.find((download) => download.id === angle.id);
      assert.ok(listed, `${angle.id} is installable`);
      assert.equal(listed.bytes, 0, `${angle.id} downloads nothing: it is in the app`);
      assert.equal(listed.bundled, true, `${angle.id} says it comes with Genex, never a size of 0`);
      assert.equal(listed.diskBytes, angle.bytes, `${angle.id}'s copy takes its own size on disk`);
    }
    assert.ok(
      plan.downloads.some((download) => download.id === ToolchainId.RaylibSource),
      "raylib's archive is a download now",
    );
  });
});

describe("missingFor's prewarm", () => {
  const WEB = [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.RaylibSource];
  const status = (installed: ToolchainId[], prewarm: ToolchainStatus["prewarm"]): ToolchainStatus => ({
    host: ToolchainHost.MacArm64,
    clt: { present: true, version: null },
    installed: installed.map((id) => ({ id, version: "1", sha12: "0".repeat(12), bytes: 1 })),
    lock: null,
    job: null,
    storeBytes: 0,
    ...(prewarm ? { prewarm } : {}),
  });
  const rows: Array<{ name: string; status: ToolchainStatus; targets: BuildTarget[]; prewarm: BuildTarget[] }> = [
    {
      name: "a ready prewarm",
      status: status(WEB, { [BuildTarget.Web]: PrewarmState.Ready }),
      targets: [BuildTarget.Web],
      prewarm: [],
    },
    {
      name: "a stale prewarm",
      status: status(WEB, { [BuildTarget.Web]: PrewarmState.Stale }),
      targets: [BuildTarget.Web],
      prewarm: [BuildTarget.Web],
    },
    {
      name: "a missing prewarm",
      status: status(WEB, { [BuildTarget.Web]: PrewarmState.Missing }),
      targets: [BuildTarget.Web],
      prewarm: [BuildTarget.Web],
    },
    {
      name: "no prewarm fact (an older status)",
      status: status(WEB, undefined),
      targets: [BuildTarget.Web],
      prewarm: [],
    },
    {
      name: "components still missing: the components are named, not the prewarm",
      status: status([ToolchainId.Cmake], { [BuildTarget.Web]: PrewarmState.Missing }),
      targets: [BuildTarget.Web],
      prewarm: [],
    },
    {
      name: "only the destinations asked for",
      status: status(WEB, { [BuildTarget.Web]: PrewarmState.Stale }),
      targets: [BuildTarget.Mac],
      prewarm: [],
    },
  ];
  for (const row of rows)
    it(row.name, () => {
      assert.deepEqual(missingFor(row.status, row.targets).prewarm, row.prewarm);
    });
});

describe("the Rust stack's pins", () => {
  const REPO = path.resolve(import.meta.dirname, "..", "..");
  const RUST_IDS: readonly ToolchainId[] = [
    ToolchainId.Rust,
    ToolchainId.RustStdWasm,
    ToolchainId.WasmBindgen,
    ToolchainId.Binaryen,
    ToolchainId.RustVendor,
    // The crate checker (crate requests), installed on the first approval and in no build lock.
    ToolchainId.CargoDeny,
    ToolchainId.CargoVet,
    ToolchainId.RustsecAdvisoryDb,
    // The relay client's libcolyseus (MP-1a), installed only for a [net] game's exports.
    ToolchainId.Colyseus,
    ToolchainId.ColyseusSource,
  ];

  /** The spike's verified pins table (`scripts/spike/rust-wgpu/pins.md`): url → sha256. */
  async function spikePins(): Promise<Map<string, string>> {
    const text = await readFile(path.join(REPO, "scripts", "spike", "rust-wgpu", "pins.md"), "utf8");
    const pins = new Map<string, string>();
    for (const line of text.split("\n")) {
      const cells = line.split("|").map((cell) => cell.trim());
      const [, , , url, digest] = cells;
      if (url?.startsWith("https://") && digest && /^[0-9a-f]{64}$/.test(digest)) pins.set(url, digest);
    }
    return pins;
  }

  it("every Rust entry is pinned to a durable release URL of its publisher", () => {
    assert.ok(RUST_MANIFEST.length > 0);
    for (const entry of RUST_MANIFEST) {
      assert.ok(RUST_IDS.includes(entry.id), entry.id);
      assert.equal(isPinned(entry), true, `${entry.id} ${entry.host}`);
      assert.equal(isDownloadable(entry), true, `${entry.id} ${entry.host}`);
      for (const archive of entry.archives) {
        assert.ok(isReleaseUrl(entry.id, archive.url), archive.url);
        assert.ok(archive.bytes > 0, archive.url);
      }
    }
  });

  it("every Rust archive is the one the spike verified against its official checksum", async () => {
    const pins = await spikePins();
    for (const entry of RUST_MANIFEST)
      for (const archive of entry.archives) assert.equal(archive.sha256, pins.get(archive.url), archive.url);
  });

  it("the Mac's Rust sysroot is five dist tarballs, one folder each", () => {
    const rust = manifestEntry(ToolchainId.Rust, ToolchainHost.MacArm64);
    assert.ok(rust);
    assert.deepEqual(
      rust.archives.map((archive) => archive.into),
      [...RUST_PARTS],
    );
    assert.equal(rust.version, "1.99.0");
    assert.equal(
      manifestEntry(ToolchainId.RustStdWasm, ToolchainHost.MacArm64)?.host,
      null,
      "one browser std for every host",
    );
  });

  it("the C++ manifest names no Rust component, so the C++ setup never downloads one", () => {
    assert.deepEqual(
      TOOLCHAIN_MANIFEST.filter((entry) => RUST_IDS.includes(entry.id)).map((entry) => entry.id),
      [],
    );
  });

  it("the vendored crate set has no entry until its release is cut and published", () => {
    assert.equal(manifestEntry(ToolchainId.RustVendor, ToolchainHost.MacArm64), null);
  });

  const rustEntry = (url: string, id: ToolchainId = ToolchainId.Rust): ToolchainEntry => ({
    id,
    version: "1.99.0",
    host: ToolchainHost.MacArm64,
    target: null,
    licence: "test",
    archives: [{ url, bytes: 1, sha256: "a".repeat(64), format: ArchiveFormat.TarXz, strip: 2, into: "" }],
  });

  const offHost: Array<{ name: string; url: string; id?: ToolchainId }> = [
    { name: "another host", url: "https://example.com/dist/rustc.tar.xz" },
    { name: "plain http", url: "http://static.rust-lang.org/dist/2026-10-01/rustc.tar.xz" },
    { name: "a lookalike host", url: "https://static.rust-lang.org.evil.test/dist/rustc.tar.xz" },
    { name: "the host as credentials", url: "https://static.rust-lang.org@evil.test/dist/rustc.tar.xz" },
    { name: "credentials on the right host", url: "https://user:pw@static.rust-lang.org/dist/rustc.tar.xz" },
    { name: "a path that climbs out of dist", url: "https://static.rust-lang.org/dist/../rustup/rustc.tar.xz" },
    { name: "an encoded climb", url: "https://static.rust-lang.org/dist/%2e%2e/rustup/rustc.tar.xz" },
    { name: "a path beside dist", url: "https://static.rust-lang.org/distx/rustc.tar.xz" },
    {
      name: "a CI run's artifact",
      url: "https://github.com/genex-games/genex-desktop/actions/runs/1/artifacts/2",
      id: ToolchainId.RustVendor,
    },
    {
      name: "the artifacts API",
      url: "https://api.github.com/repos/genex-games/genex-desktop/actions/artifacts/2/zip",
      id: ToolchainId.RustVendor,
    },
    {
      name: "another repository's release",
      url: "https://github.com/someone/genex-desktop/releases/download/v1/vendor.tar.gz",
      id: ToolchainId.RustVendor,
    },
    {
      name: "another publisher's release for wasm-bindgen",
      url: "https://github.com/rustwasm/wasm-bindgen-fork/releases/download/0.2.129/wasm-bindgen.tar.gz",
      id: ToolchainId.WasmBindgen,
    },
  ];
  for (const row of offHost) {
    it(`a manifest URL on ${row.name} is refused`, () => {
      const entry = rustEntry(row.url, row.id);
      assert.equal(isReleaseUrl(entry.id, row.url), false);
      assert.throws(
        () => releaseManifest([entry]),
        (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.Unpinned,
      );
    });
  }

  it("a recipe naming a URL off its release host is refused as it loads", () => {
    const recipe = { schema: 1, entries: [{ ...rustEntry("https://mirror.example/rustc.tar.xz") }] };
    assert.throws(() => rustManifestOf(recipe), ToolchainError);
  });

  it("the Genex release host accepts the vendored set's published asset", () => {
    const url = "https://github.com/genex-games/genex-desktop/releases/download/genex-0.1.0/rust-vendor.tar.zst";
    assert.equal(isReleaseUrl(ToolchainId.RustVendor, url), true);
    assert.deepEqual(releaseManifest([rustEntry(url, ToolchainId.RustVendor)]).length, 1);
  });

  it("every C++ entry names its publisher's release host too", () => {
    for (const entry of TOOLCHAIN_MANIFEST)
      for (const archive of entry.archives) assert.ok(isReleaseUrl(entry.id, archive.url), archive.url);
  });
});
