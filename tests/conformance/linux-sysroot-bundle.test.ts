/**
 * Linux setup receives the verified headers from Genex's resources, without a hosting URL; the
 * sysroot also carries the link stubs, `.pc` files and pkg-config a Rust game's cpal and gilrs
 * link through (M4.2, `native/linux-sysroot/manifest.json`).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bundleLinuxSysroot, verifyLinuxSysrootBundle } from "../../scripts/bundle-linux-sysroot.mjs";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { ToolchainHost, ToolchainId, ToolchainInstallPhase, ToolchainProblem } from "../../src/shared/toolchain.ts";
import { ArtifactError, ArtifactFault, sha256Hex } from "../../src/substrate/toolchain-store/artifact.ts";
import { BundleState, bundledState, isBundled } from "../../src/substrate/toolchain-store/bundled.ts";
import { installComponents, ReceiptSource, readReceipts } from "../../src/substrate/toolchain-store/install.ts";
import {
  bundledLinuxSysrootFolder,
  isBundledLinuxSysroot,
  LINUX_SYSROOT_BUNDLE_PIN,
  parseLinuxSysrootPin,
  verifyLinuxSysrootFolder,
} from "../../src/substrate/toolchain-store/linux-sysroot-bundle.ts";
import { isDownloadable, manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { ElfFileType, LINUX_X64_MACHINE, parseElf } from "../../src/substrate/native-gate-elf.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PIN = LINUX_SYSROOT_BUNDLE_PIN;
const ARCHIVE = path.join(REPO, "native", "linux-sysroot", PIN.archive.file);
const POSIX_ONLY = process.platform === "win32" ? { skip: "symlink creation needs Windows privileges" } : {};

function sysrootEntry() {
  const entry = manifestEntry(ToolchainId.LinuxSysroot, ToolchainHost.MacArm64);
  assert.ok(entry?.local);
  return entry;
}

async function fixture() {
  const root = await realpath(await tmpDir("linux-sysroot-bundle-"));
  const resources = path.join(root, "resources");
  const store = path.join(root, "store");
  await mkdir(store);
  await writeFile(path.join(store, "keep.txt"), "existing store contents");
  return { root, resources, store };
}

function deps(resources: string, fetches: string[]) {
  return {
    resources,
    freeBytes: async () => 1024 ** 3,
    onJob: () => {},
    run: async () => {
      throw new Error("a headers install runs no executable");
    },
    fetch: async (url: string) => {
      fetches.push(url);
      throw new Error("a bundled install fetches nothing");
    },
  };
}

describe("the bundled Linux headers pin", () => {
  it("is available with an unpublished URL, and only recognizes the exact artifact pin", () => {
    const entry = sysrootEntry();
    assert.equal(entry.local?.fetch?.url, null);
    assert.equal(isBundled(entry), true);
    assert.equal(isDownloadable(entry), true);
    for (const changed of [
      { ...entry, version: "another-version" },
      { ...entry, target: BuildTarget.Windows },
      { ...entry, host: ToolchainHost.LinuxX64 },
      { ...entry, local: { ...entry.local, manifestSha256: "f".repeat(64) } },
      { ...entry, local: { ...entry.local, bytes: PIN.bytes + 1 } },
    ])
      assert.equal(isBundledLinuxSysroot(changed), false);
  });

  it("rejects unsafe names, incomplete digests and invalid sizes before a path is used", () => {
    const valid = { schema: 1, ...PIN };
    assert.deepEqual(parseLinuxSysrootPin(valid), PIN);
    for (const change of [
      { version: "../escape" },
      { target: "/linux" },
      { manifestSha256: "short" },
      { manifestBytes: -1 },
      { files: 0 },
      { imageDigest: "almalinux:latest" },
      { archive: { ...PIN.archive, file: "../outside.tar.gz" } },
      { archive: { ...PIN.archive, bytes: 0 } },
    ])
      assert.equal(parseLinuxSysrootPin({ ...valid, ...change }), null);
    assert.throws(
      () => bundledLinuxSysrootFolder("resources", { ...PIN, version: "../../outside" }),
      (error: unknown) => error instanceof ArtifactError && error.fault === ArtifactFault.BadPath,
    );
  });
});

describe("provisioning the bundled Linux headers", () => {
  it("builds entirely from the checked-in archive, verifies provenance and every file, and installs once", async () => {
    const { resources, store } = await fixture();
    const archive = await readFile(ARCHIVE);
    assert.equal(archive.length, PIN.archive.bytes);
    assert.equal(sha256Hex(archive), PIN.archive.sha256);
    const copied = await bundleLinuxSysroot({ resources });
    assert.deepEqual(copied, { folder: bundledLinuxSysrootFolder(resources), files: PIN.files, bytes: PIN.bytes });
    assert.deepEqual(await verifyLinuxSysrootBundle(resources), copied);
    const entry = sysrootEntry();
    assert.equal(await bundledState(resources, entry), BundleState.Present);
    const fetched: string[] = [];
    const job = await installComponents(store, [entry], deps(resources, fetched));
    assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
    const [receipt] = await readReceipts(store);
    assert.ok(receipt);
    assert.deepEqual(
      [receipt.id, receipt.source, receipt.target, receipt.sha256, receipt.bytes],
      [ToolchainId.LinuxSysroot, ReceiptSource.Bundled, BuildTarget.Linux, PIN.manifestSha256, PIN.bytes],
    );
    const installed = path.join(store, receipt.id, `${receipt.version}-${receipt.sha12}`);
    assert.equal(
      await readFile(path.join(installed, "usr/include/X11/Xlib.h"), "utf8"),
      await readFile(path.join(copied.folder, "usr/include/X11/Xlib.h"), "utf8"),
    );
    const before = await readFile(path.join(installed, "receipt.json"));
    await rm(resources, { recursive: true });
    const repeated = await installComponents(store, [entry], deps(resources, fetched));
    assert.equal(repeated.phase, ToolchainInstallPhase.Installed, "installed components remain usable without recopy");
    assert.deepEqual(await readFile(path.join(installed, "receipt.json")), before);
    assert.deepEqual(fetched, []);
    assert.equal(await readFile(path.join(store, "keep.txt"), "utf8"), "existing store contents");
  });

  it("refuses a missing bundle with a typed problem and keeps existing store contents", async () => {
    const { resources, store } = await fixture();
    const entry = sysrootEntry();
    assert.equal(await bundledState(resources, entry), BundleState.Missing);
    const fetched: string[] = [];
    const job = await installComponents(store, [entry], deps(resources, fetched));
    assert.deepEqual([job.phase, job.problem], [ToolchainInstallPhase.Failed, ToolchainProblem.NotBundled]);
    assert.deepEqual(fetched, []);
    assert.deepEqual(await readReceipts(store), []);
    assert.equal(await readFile(path.join(store, "keep.txt"), "utf8"), "existing store contents");
    assert.equal(existsSync(path.join(store, ".staging")), false);
  });

  it("rejects altered archive bytes before creating resources", async () => {
    const { root, resources } = await fixture();
    const archive = path.join(root, "bad.tar.gz");
    const bytes = await readFile(ARCHIVE);
    bytes[100] = (bytes[100] ?? 0) ^ 1;
    await writeFile(archive, bytes);
    await assert.rejects(
      () => bundleLinuxSysroot({ resources, archive }),
      (error: unknown) => error instanceof ArtifactError && error.fault === ArtifactFault.FileDigest,
    );
    assert.equal(existsSync(resources), false);
  });

  it("rejects an archive symlink before extraction", POSIX_ONLY, async () => {
    const { root, resources } = await fixture();
    const archive = path.join(root, "link.tar.gz");
    await symlink(ARCHIVE, archive);
    await assert.rejects(
      () => bundleLinuxSysroot({ resources, archive }),
      (error: unknown) => error instanceof ArtifactError && error.fault === ArtifactFault.NotRegular,
    );
    assert.equal(existsSync(resources), false);
  });
});

describe("refusing an altered bundled Linux sysroot", () => {
  const rows = [
    { name: "manifest", problem: ToolchainProblem.Integrity, rel: "manifest.json", action: "alter" },
    { name: "listed bytes", problem: ToolchainProblem.Integrity, rel: "usr/include/X11/Xlib.h", action: "alter" },
    { name: "missing file", problem: ToolchainProblem.Integrity, rel: "usr/include/X11/Xlib.h", action: "remove" },
    { name: "extra file", problem: ToolchainProblem.Archive, rel: "extra.txt", action: "extra" },
  ];
  for (const row of rows)
    it(`refuses ${row.name} and leaves no installed or staged component`, async () => {
      const { resources, store } = await fixture();
      const { folder } = await bundleLinuxSysroot({ resources });
      const at = path.join(folder, row.rel);
      if (row.action === "remove") await rm(at);
      else if (row.action === "extra") await writeFile(at, "not pinned");
      else {
        const bytes = await readFile(at);
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        await writeFile(at, bytes);
      }
      const fetched: string[] = [];
      const job = await installComponents(store, [sysrootEntry()], deps(resources, fetched));
      assert.deepEqual([job.phase, job.problem], [ToolchainInstallPhase.Failed, row.problem]);
      assert.deepEqual(fetched, []);
      assert.deepEqual(await readReceipts(store), []);
      assert.equal(existsSync(path.join(store, ".staging")), false);
      assert.equal(await readFile(path.join(store, "keep.txt"), "utf8"), "existing store contents");
    });

  it("refuses a link replacing a listed file without reading its target", POSIX_ONLY, async () => {
    const { resources, store } = await fixture();
    const { folder } = await bundleLinuxSysroot({ resources });
    const at = path.join(folder, "usr/include/X11/Xlib.h");
    await rm(at);
    await symlink("/does/not/exist", at);
    const fetched: string[] = [];
    const job = await installComponents(store, [sysrootEntry()], deps(resources, fetched));
    assert.deepEqual([job.phase, job.problem], [ToolchainInstallPhase.Failed, ToolchainProblem.Archive]);
    assert.deepEqual(fetched, []);
    assert.equal((await lstat(at)).isSymbolicLink(), true, "the source remains untouched");
    assert.equal(existsSync(path.join(store, ".staging")), false);
  });

  it("validates target and source image even when a caller supplies a matching synthetic manifest pin", async () => {
    const { resources } = await fixture();
    const { folder } = await bundleLinuxSysroot({ resources });
    const at = path.join(folder, "manifest.json");
    const fields = JSON.parse(await readFile(at, "utf8"));
    fields.imageDigest = `sha256:${"e".repeat(64)}`;
    const bytes = Buffer.from(JSON.stringify(fields));
    await writeFile(at, bytes);
    const pin = { ...PIN, manifestBytes: bytes.length, manifestSha256: sha256Hex(bytes) };
    await assert.rejects(
      () => verifyLinuxSysrootFolder(folder, pin),
      (error: unknown) => error instanceof ArtifactError && error.fault === ArtifactFault.Origin,
    );
  });
});

/** One row of `native/linux-sysroot/manifest.json`: a binding crate's link stub and its `.pc` file. */
interface StubRow {
  crate: string;
  version: string;
  prefix: string;
  soname: string;
  link: string;
  pc: { name: string; version: string };
}

const STUB_RECIPE: { glibc: string; stubs: StubRow[] } = JSON.parse(
  await readFile(path.join(REPO, "native", "linux-sysroot", "manifest.json"), "utf8"),
);

describe("the link stubs a Rust game's cpal and gilrs need (M4.2)", () => {
  it("names libasound for alsa-sys and libudev for libudev-sys, glibc 2.28", () => {
    assert.equal(STUB_RECIPE.glibc, "2.28");
    assert.deepEqual(
      STUB_RECIPE.stubs.map((row) => [row.crate, row.soname, row.pc.name]),
      [
        ["alsa-sys", "libasound.so.2", "alsa"],
        ["libudev-sys", "libudev.so.1", "libudev"],
      ],
    );
  });

  it("bundles each stub as an x86_64 shared object with the library's real SONAME and its .pc file", async () => {
    const { resources } = await fixture();
    const { folder } = await bundleLinuxSysroot({ resources });
    const manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
    for (const row of STUB_RECIPE.stubs) {
      const image = parseElf(await readFile(path.join(folder, "usr", "lib64", `lib${row.link}.so`)));
      assert.equal(image.fileType, ElfFileType.SharedObject, row.crate);
      assert.equal(image.machine, LINUX_X64_MACHINE, row.crate);
      assert.equal(image.soname, row.soname, row.crate);
      assert.deepEqual(image.needed, [], `${row.crate}: a stub needs nothing`);
      const pc = await readFile(path.join(folder, "usr", "lib64", "pkgconfig", `${row.pc.name}.pc`), "utf8");
      assert.match(pc, new RegExp(`^Version: ${row.pc.version.replaceAll(".", "\\.")}$`, "m"), row.crate);
      assert.match(pc, new RegExp(`^Libs: -L\\$\\{libdir\\} -l${row.link}$`, "m"), row.crate);
      const recorded = manifest.linkStubs.stubs.find((stub: { crate: string }) => stub.crate === row.crate);
      assert.ok(recorded?.symbols > 0, `${row.crate}: the manifest records the stub's symbols`);
      assert.equal(recorded.soname, row.soname);
    }
    assert.equal(manifest.linkStubs.zig, "0.16.0");
  });

  it("answers pkg-config's questions from the .pc files with sysroot-prefixed paths", POSIX_ONLY, async () => {
    const { resources } = await fixture();
    const { folder } = await bundleLinuxSysroot({ resources });
    const pkgConfig = path.join(folder, "bin", "pkg-config");
    assert.ok(((await lstat(pkgConfig)).mode & 0o111) !== 0, "pkg-config is executable");
    const env = {
      PATH: "/usr/bin:/bin",
      PKG_CONFIG_PATH: path.join(folder, "usr", "lib64", "pkgconfig"),
      PKG_CONFIG_SYSROOT_DIR: folder,
    };
    const libs = await execFileAsync(pkgConfig, ["--libs", "--cflags", "alsa"], { env });
    assert.equal(libs.stdout.trim(), `-I${folder}/usr/include -L${folder}/usr/lib64 -lasound`);
    const version = await execFileAsync(pkgConfig, ["--modversion", "libudev"], { env });
    assert.equal(version.stdout.trim(), "239");
    await assert.rejects(
      () => execFileAsync(pkgConfig, ["--libs", "x11-not-a-stub"], { env }),
      (error: { code?: number; stderr?: string }) => error.code === 1 && /was not found/.test(error.stderr ?? ""),
    );
  });
});
