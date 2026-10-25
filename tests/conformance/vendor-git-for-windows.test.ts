/**
 * Git for Windows in a Windows package (`scripts/vendor-git-for-windows.ts`,
 * `scripts/package-git.cjs`): only the pinned bytes are ever unpacked, the trimmed parts are gone
 * and everything else ships, a release that no longer has a trimmed path is refused for review,
 * and the package's resources get the copy where the app looks for it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import {
  GIT_FOR_WINDOWS_RELEASES,
  GIT_FOR_WINDOWS_TRIM,
  sevenZip,
  type VendorGitDeps,
  vendorGitForWindows,
  withoutCredentialHelper,
} from "../../scripts/vendor-git-for-windows.ts";
import { BUNDLED_GIT_DIR } from "../../src/substrate/windows-sandbox.ts";
import { tmpDir } from "../helpers/tmp.ts";

const require = createRequire(import.meta.url);
const packageGit = require("../../scripts/package-git.cjs") as {
  BUNDLED_GIT_DIR: string;
  VENDORED_GIT: string;
  copyBundledGit(buildPath: string, platform: string, vendored?: string): Promise<void>;
};

/** Trimmed entries that are folders in the release; every other one is a file. */
const TRIMMED_DIRS = new Set([
  "etc/post-install",
  "ucrt64/lib/reg1.3",
  "ucrt64/lib/tcl8",
  "ucrt64/lib/tcl8.6",
  "ucrt64/lib/thread2.8.13",
  "ucrt64/lib/tk8.6",
  "ucrt64/share/doc",
  "ucrt64/share/git-gui",
  "usr/share/vim",
]);
/** Git Credential Manager's files, in both folders it ships in, and the selector beside git. */
const CREDENTIAL_MANAGER = [
  "ucrt64/bin/Avalonia.Base.dll",
  "ucrt64/bin/Avalonia.dll",
  "ucrt64/bin/GitHub.dll",
  "ucrt64/bin/Microsoft.Identity.Client.dll",
  "ucrt64/bin/System.Text.Json.dll",
  "ucrt64/bin/git-credential-helper-selector.exe",
  "ucrt64/bin/git-credential-manager.exe",
  "ucrt64/bin/git-credential-manager.exe.config",
  "ucrt64/bin/msalruntime.dll",
  "ucrt64/libexec/git-core/Avalonia.Base.dll",
  "ucrt64/libexec/git-core/libSkiaSharp.dll",
  "ucrt64/libexec/git-core/msalruntime.dll",
];
/** What ships: Git Bash, git and its DLLs (both copies), git-lfs, xxd and the licenses. */
const KEPT = [
  "LICENSE.txt",
  "bin/bash.exe",
  "etc/gitconfig",
  "cmd/git.exe",
  "ucrt64/bin/git-lfs.exe",
  "ucrt64/bin/git.exe",
  "ucrt64/bin/libcurl-4.dll",
  "ucrt64/libexec/git-core/git-remote-https.exe",
  "ucrt64/libexec/git-core/libcurl-4.dll",
  "usr/bin/xxd.exe",
  "usr/share/licenses/bash/COPYING",
];

/** Write a release's tree under `dir`, as 7-Zip would unpack it, leaving out `without`. */
async function unpackRelease(dir: string, without: readonly string[] = []): Promise<void> {
  const trimmed = Object.values(GIT_FOR_WINDOWS_TRIM).flat();
  for (const entry of [...trimmed, ...CREDENTIAL_MANAGER, ...KEPT]) {
    if (without.includes(entry)) continue;
    const file = TRIMMED_DIRS.has(entry) ? path.join(dir, entry, "inside.txt") : path.join(dir, entry);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, entry === "etc/gitconfig" ? RELEASE_GITCONFIG : entry);
  }
}

/** The 2.56.0.windows.2 portable edition's `etc/gitconfig`, as it ships. */
const RELEASE_GITCONFIG = [
  "[core]",
  "\tsymlinks = false",
  "\tautocrlf = true",
  '[filter "lfs"]',
  "\tclean = git-lfs clean -- %f",
  "\trequired = true",
  "[credential]",
  "\thelper = helper-selector",
  "",
].join("\n");

/** A release archive (any bytes: the stand-in 7-Zip never reads it) and its pin. */
async function release() {
  const served = path.join(await tmpDir("git-release-"), "PortableGit-test.7z.exe");
  await writeFile(served, "a portable git");
  const sha256 = createHash("sha256")
    .update(await readFile(served))
    .digest("hex");
  return {
    served,
    pin: { version: "9.9.9.windows.1", url: "https://example.invalid/PortableGit-test.7z.exe", sha256 },
  };
}

/** Stand-ins for the network (serving `served`) and 7-Zip (unpacking a release's tree), recording each use. */
function standIns(served: string, without: readonly string[] = []) {
  const downloads: string[] = [];
  const unpacked: string[][] = [];
  const deps: VendorGitDeps = {
    download: async (url, file) => {
      downloads.push(url);
      await writeFile(file, await readFile(served));
    },
    run: async (command, args) => {
      unpacked.push([command, ...args]);
      const out = args.find((arg) => arg.startsWith("-o"));
      assert.ok(out, "7-Zip is told where to unpack");
      await unpackRelease(out.slice(2), without);
    },
  };
  return { deps, downloads, unpacked };
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/"))
    .sort();
}

describe("vendoring Git for Windows into a Windows build", () => {
  it("ships the release without its documentation, GUIs, editor, credential manager and run-once setup", async () => {
    const { served, pin } = await release();
    const cacheDir = await tmpDir("git-cache-");
    const dest = path.join(await tmpDir("git-dest-"), "git");
    const { deps, downloads, unpacked } = standIns(served);
    const vendored = await vendorGitForWindows(dest, { cacheDir, release: pin, deps, sevenZip: "7z-test" });
    assert.deepEqual(await filesUnder(dest), [...KEPT].sort());
    assert.equal(vendored.version, "9.9.9.windows.1");
    assert.equal(vendored.files, KEPT.length);
    assert.deepEqual(downloads, [pin.url]);
    assert.equal(unpacked[0]?.[0], "7z-test");
    assert.ok(unpacked[0]?.includes("x"), "an extraction with full paths");
    // A second build takes the cached archive and replaces what the first one left.
    await writeFile(path.join(dest, "stale.txt"), "left over");
    await vendorGitForWindows(dest, { cacheDir, release: pin, deps, sevenZip: "7z-test" });
    assert.deepEqual(downloads, [pin.url]);
    assert.deepEqual(await filesUnder(dest), [...KEPT].sort());
  });

  it("keeps the system config but drops its credential helper, which the trim removed", async () => {
    const { served, pin } = await release();
    const dest = path.join(await tmpDir("git-dest-"), "git");
    await vendorGitForWindows(dest, {
      cacheDir: await tmpDir("git-cache-"),
      release: pin,
      deps: standIns(served).deps,
    });
    const config = await readFile(path.join(dest, "etc", "gitconfig"), "utf8");
    assert.doesNotMatch(config, /credential|helper/i);
    assert.match(config, /autocrlf = true/);
    assert.match(config, /\[filter "lfs"\]\n\tclean = git-lfs clean -- %f\n\trequired = true\n/);
    assert.equal(withoutCredentialHelper("[Credential]\n\thelper = x\n[core]\n\ta = 1"), "[core]\n\ta = 1\n");
  });

  it("refuses an archive that is not the pinned bytes, and unpacks nothing", async () => {
    const { served, pin } = await release();
    const cacheDir = await tmpDir("git-cache-");
    const dest = path.join(await tmpDir("git-dest-"), "git");
    const { deps, unpacked } = standIns(served);
    await assert.rejects(
      vendorGitForWindows(dest, { cacheDir, release: { ...pin, sha256: "0".repeat(64) }, deps, sevenZip: "7z" }),
      /Git for Windows archive .* has SHA-256 [0-9a-f]{64}, not the pinned 0{64}: refusing it/,
    );
    assert.deepEqual(await readdir(cacheDir), [], "no archive cached, not even a partial one");
    assert.deepEqual(unpacked, []);
    assert.equal(existsSync(dest), false);
  });

  it("refuses a release that no longer has a trimmed path, so a new Git is reviewed before it ships", async () => {
    const { served, pin } = await release();
    const { deps } = standIns(served, ["usr/bin/vimtutor"]);
    await assert.rejects(
      vendorGitForWindows(path.join(await tmpDir("git-dest-"), "git"), {
        cacheDir: await tmpDir("git-cache-"),
        release: pin,
        deps,
        sevenZip: "7z",
      }),
      /Git for Windows 9\.9\.9\.windows\.1 has no usr\/bin\/vimtutor: review GIT_FOR_WINDOWS_TRIM/,
    );
  });

  it("refuses a release without Git Bash", async () => {
    const { served, pin } = await release();
    const { deps } = standIns(served, ["bin/bash.exe"]);
    await assert.rejects(
      vendorGitForWindows(path.join(await tmpDir("git-dest-"), "git"), {
        cacheDir: await tmpDir("git-cache-"),
        release: pin,
        deps,
        sevenZip: "7z",
      }),
      /has no bin\/bash\.exe/,
    );
  });

  it("refuses an architecture no release is pinned for", async () => {
    await assert.rejects(
      vendorGitForWindows(await tmpDir("git-dest-"), { arch: "ia32", cacheDir: await tmpDir("git-cache-") }),
      /ia32/,
    );
  });

  it("pins the x64 portable edition by version and SHA-256, over https from git-for-windows", () => {
    const x64 = GIT_FOR_WINDOWS_RELEASES.x64;
    assert.ok(x64);
    assert.ok(
      x64.url.startsWith(`https://github.com/git-for-windows/git/releases/download/v${x64.version}/PortableGit-`),
    );
    assert.match(x64.url, /-64-bit\.7z\.exe$/);
    assert.match(x64.sha256, /^[0-9a-f]{64}$/);
  });

  it("runs the 7-Zip GENEX_7Z names, else 7z", () => {
    assert.equal(
      sevenZip({ GENEX_7Z: "/opt/7zz" }, () => true),
      "/opt/7zz",
    );
    assert.equal(
      sevenZip({}, () => false),
      "7z",
    );
  });
});

describe("Git for Windows in a package", () => {
  it("copies the vendored Git into a Windows package's resources, where the app looks for it", async () => {
    const vendored = await tmpDir("git-vendored-");
    await unpackRelease(vendored);
    const resources = path.join(await tmpDir("git-package-"), "resources");
    await mkdir(path.join(resources, "app"), { recursive: true });
    await packageGit.copyBundledGit(path.join(resources, "app"), "win32", vendored);
    assert.equal(packageGit.BUNDLED_GIT_DIR, BUNDLED_GIT_DIR);
    assert.equal(existsSync(path.join(resources, BUNDLED_GIT_DIR, "bin", "bash.exe")), true);
    assert.equal(existsSync(path.join(resources, "app", BUNDLED_GIT_DIR)), false, "outside app.asar");
  });

  it("copies nothing into a macOS or Linux package", async () => {
    const resources = path.join(await tmpDir("git-package-"), "resources");
    await mkdir(path.join(resources, "app"), { recursive: true });
    for (const platform of ["darwin", "linux"])
      await packageGit.copyBundledGit(path.join(resources, "app"), platform, "/nowhere");
    assert.deepEqual(await readdir(resources), ["app"]);
  });

  it("refuses a Windows package when the build vendored no Git", async () => {
    const resources = path.join(await tmpDir("git-package-"), "resources");
    await assert.rejects(
      packageGit.copyBundledGit(path.join(resources, "app"), "win32", path.join(resources, "none")),
      /No vendored Git for Windows/,
    );
  });

  it("is Forge's afterCopy step, from where the build vendors it", async () => {
    const config = require("../../forge.config.cjs");
    const hooks = config.packagerConfig.afterCopy as Array<(args: { buildPath: string; platform: string }) => unknown>;
    assert.equal(hooks.length, 1);
    const resources = path.join(await tmpDir("git-package-"), "resources");
    await mkdir(path.join(resources, "app"), { recursive: true });
    await hooks[0]?.({ buildPath: path.join(resources, "app"), platform: "linux" });
    assert.deepEqual(await readdir(resources), ["app"]);
    assert.ok(packageGit.VENDORED_GIT.endsWith(path.join("node_modules", ".cache", "genex", "git-for-windows", "git")));
  });

  it("leaves the build's download cache out of app.asar, so Git ships once and its archive not at all", () => {
    const config = require("../../forge.config.cjs");
    const ignore = config.packagerConfig.ignore as RegExp[];
    // The packager matches each copied path, relative to the app folder with a leading `/`. A
    // folder under node_modules without a package.json is no module, so only this list keeps it out.
    const ignored = (name: string) => ignore.some((regex) => regex.test(name));
    for (const name of [
      "/node_modules/.cache",
      "/node_modules/.cache/genex/git-for-windows/git/bin/bash.exe",
      "/node_modules/.cache/genex/git-for-windows-archive/PortableGit-2.56.0.2-64-bit.7z.exe",
      "/node_modules/.cache/genex/cua-driver/cua-driver.tar.gz",
    ])
      assert.equal(ignored(name), true, name);
    for (const name of ["/node_modules/node-pty/package.json", "/dist/main/main.js", "/package.json"])
      assert.equal(ignored(name), false, name);
  });
});
