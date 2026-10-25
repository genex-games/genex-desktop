/**
 * Vendoring cua-driver into a macOS or Windows build (`scripts/vendor-cua-driver.ts`): only the pinned
 * bytes are ever unpacked, only the executable ships (on macOS thinned to the build's architecture,
 * runnable; on Windows as cua signed it), with cua's license and notices beside it, and a cached
 * archive makes no second request.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CUA_DRIVER_RELEASE,
  CUA_DRIVER_WINDOWS_RELEASES,
  type VendorCuaDriverDeps,
  vendorCuaDriver,
} from "../../scripts/vendor-cua-driver.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A release archive shaped like cua's: the executable and the SDK files the app does not ship. */
async function releaseArchive(): Promise<{ archive: string; sha256: string }> {
  const dir = await tmpDir("cua-release-");
  const files = path.join(dir, "files");
  await mkdir(files);
  await writeFile(path.join(files, "cua-driver"), "a universal driver");
  await writeFile(path.join(files, "libcua_driver_sdk.dylib"), "an sdk");
  await writeFile(path.join(files, "cua-cursor-theme"), "a theme tool");
  const archive = path.join(dir, "cua-driver-rs-test-darwin-universal-binary.tar.gz");
  await promisify(execFile)("tar", [
    "-czf",
    archive,
    "-C",
    files,
    "cua-driver",
    "libcua_driver_sdk.dylib",
    "cua-cursor-theme",
  ]);
  return {
    archive,
    sha256: createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
  };
}

/** Stand-ins for the network (serving `served`) and `lipo` (a copy), recording each use. */
function standIns(served: string) {
  const downloads: string[] = [];
  const thinned: string[][] = [];
  const deps: VendorCuaDriverDeps = {
    download: async (url, file) => {
      downloads.push(url);
      await copyFile(served, file);
    },
    run: async (command, args) => {
      if (command !== "lipo") {
        await promisify(execFile)(command, args);
        return;
      }
      thinned.push(args);
      await copyFile(args[0]!, args.at(-1)!);
    },
  };
  return { deps, downloads, thinned };
}

describe("vendoring cua-driver into a macOS build", () => {
  it("ships the executable alone, thinned and runnable, with cua's license, notices and version", async () => {
    const { archive, sha256 } = await releaseArchive();
    const release = { version: "9.9.9", url: "https://example.invalid/r/cua.tar.gz", sha256 } as const;
    const resources = await tmpDir("cua-resources-");
    const cacheDir = await tmpDir("cua-cache-");
    const { deps, downloads, thinned } = standIns(archive);
    const vendored = await vendorCuaDriver(ROOT, resources, {
      arch: "arm64",
      platform: "darwin",
      cacheDir,
      release,
      deps,
    });
    const dest = path.join(resources, "cua-driver");
    assert.deepEqual((await readdir(dest)).sort(), ["LICENSE.md", "THIRD_PARTY_NOTICES.md", "VERSION", "cua-driver"]);
    assert.equal((await stat(path.join(dest, "cua-driver"))).mode & 0o777, 0o755);
    assert.equal(await readFile(path.join(dest, "VERSION"), "utf8"), "9.9.9\n");
    assert.match(await readFile(path.join(dest, "LICENSE.md"), "utf8"), /MIT License[\s\S]*Cua AI, Inc\./);
    assert.deepEqual(
      thinned.map((args) => args.slice(1, 3)),
      [["-thin", "arm64"]],
    );
    assert.equal(vendored.version, "9.9.9");
    assert.deepEqual(downloads, [release.url]);
    // A second build takes the cached archive: no request.
    await vendorCuaDriver(ROOT, resources, { arch: "x64", platform: "darwin", cacheDir, release, deps });
    assert.deepEqual(downloads, [release.url]);
    assert.deepEqual(thinned.at(-1)?.slice(1, 3), ["-thin", "x86_64"]);
  });

  it("refuses an archive that is not the pinned bytes, and keeps nothing of it", async () => {
    const { archive } = await releaseArchive();
    const release = { version: "9.9.9", url: "https://example.invalid/r/cua.tar.gz", sha256: "0".repeat(64) } as const;
    const resources = await tmpDir("cua-resources-");
    const cacheDir = await tmpDir("cua-cache-");
    const { deps, thinned } = standIns(archive);
    await assert.rejects(
      vendorCuaDriver(ROOT, resources, { arch: "arm64", platform: "darwin", cacheDir, release, deps }),
      /has SHA-256 [0-9a-f]{64}, not the pinned 0{64}: refusing it/,
    );
    assert.deepEqual(await readdir(cacheDir), [], "no archive cached, not even a partial one");
    assert.equal(existsSync(path.join(resources, "cua-driver")), false, "nothing placed");
    assert.deepEqual(thinned, [], "nothing unpacked");
  });

  it("downloads again over a cached archive that changed", async () => {
    const { archive, sha256 } = await releaseArchive();
    const release = { version: "9.9.9", url: "https://example.invalid/r/cua.tar.gz", sha256 } as const;
    const cacheDir = await tmpDir("cua-cache-");
    await writeFile(path.join(cacheDir, "cua.tar.gz"), "tampered");
    const { deps, downloads } = standIns(archive);
    await vendorCuaDriver(ROOT, await tmpDir("cua-resources-"), {
      arch: "arm64",
      platform: "darwin",
      cacheDir,
      release,
      deps,
    });
    assert.deepEqual(downloads, [release.url]);
  });

  it("refuses an architecture cua ships no driver for", async () => {
    await assert.rejects(
      vendorCuaDriver(ROOT, await tmpDir("cua-resources-"), { arch: "ia32", platform: "darwin" }),
      /ia32/,
    );
  });

  it("pins a cua release by version and SHA-256, over https from trycua/cua, the same on both systems", () => {
    for (const release of [CUA_DRIVER_RELEASE, ...Object.values(CUA_DRIVER_WINDOWS_RELEASES)]) {
      assert.match(release.url, /^https:\/\/github\.com\/trycua\/cua\/releases\/download\//);
      assert.ok(release.url.includes(release.version));
      assert.match(release.sha256, /^[0-9a-f]{64}$/);
      assert.equal(release.version, CUA_DRIVER_RELEASE.version, "one driver version, tested once");
    }
  });
});

describe("vendoring cua-driver into a Windows build", () => {
  /** A stand-in release archive (only its digest matters) and 7-Zip, which "extracts" the named file. */
  async function windowsRelease() {
    const archive = path.join(await tmpDir("cua-release-"), "cua-driver-rs-test-windows-x86_64-binary.zip");
    await writeFile(archive, "a zip with cua-driver.exe, cua-driver-uia.exe and an sdk");
    const sha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    const runs: Array<{ command: string; args: string[] }> = [];
    const deps: VendorCuaDriverDeps = {
      download: async (_url, file) => copyFile(archive, file),
      run: async (command, args) => {
        runs.push({ command, args });
        const out = args.find((arg) => arg.startsWith("-o"))?.slice(2);
        if (out) await writeFile(path.join(out, args.at(-1)!), "a signed windows driver");
      },
    };
    const release = { version: "9.9.9", url: "https://example.invalid/r/cua.zip", sha256 } as const;
    return { release, deps, runs };
  }

  it("ships cua-driver.exe alone, as cua signed it, with cua's license, notices and version", async () => {
    const { release, deps, runs } = await windowsRelease();
    const resources = await tmpDir("cua-resources-");
    const options = { arch: "x64", platform: "win32", cacheDir: await tmpDir("cua-cache-"), release, deps } as const;
    const vendored = await vendorCuaDriver(ROOT, resources, { ...options, sevenZip: "C:\\7-Zip\\7z.exe" });
    const dest = path.join(resources, "cua-driver");
    assert.deepEqual((await readdir(dest)).sort(), [
      "LICENSE.md",
      "THIRD_PARTY_NOTICES.md",
      "VERSION",
      "cua-driver.exe",
    ]);
    assert.equal(await readFile(path.join(dest, "cua-driver.exe"), "utf8"), "a signed windows driver");
    assert.equal(await readFile(path.join(dest, "VERSION"), "utf8"), "9.9.9\n");
    assert.equal(vendored.version, "9.9.9");
    // Only the executable, by its exact name and without the archive's folders; no lipo, no re-signing.
    assert.deepEqual(
      runs.map(({ command, args }) => [command, args[0], args.at(-1)]),
      [["C:\\7-Zip\\7z.exe", "e", "cua-driver.exe"]],
    );
  });

  it("refuses an architecture Genex ships no Windows driver for, and a system with none", async () => {
    const resources = await tmpDir("cua-resources-");
    await assert.rejects(vendorCuaDriver(ROOT, resources, { arch: "arm64", platform: "win32" }), /arm64/);
    await assert.rejects(vendorCuaDriver(ROOT, resources, { arch: "x64", platform: "linux" }), /linux/);
    assert.equal(existsSync(path.join(resources, "cua-driver")), false, "nothing placed");
  });
});
