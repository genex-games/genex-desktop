/**
 * Genex's own git in a macOS build (`scripts/vendor-git-for-mac.ts`): built from the pinned source
 * tarball only, by Apple's compiler with nothing from the build machine's own PATH or Homebrew,
 * for the build's processor; only the programs Genex and its agents reach ship, with git's
 * licenses; a release missing one of them, or a program built for another processor, is refused.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { MAC_GIT_FILES, type VendorMacGitDeps, vendorGitForMac } from "../../scripts/vendor-git-for-mac.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A 64-bit Mach-O header for `cpu` (CPU_TYPE_ARM64 or CPU_TYPE_X86_64), as a built program starts. */
function machO(cpu: number): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  header.writeUInt32LE(2, 12);
  return header;
}
const CPU = { arm64: 0x0100000c, x64: 0x01000007 } as const;

/** What `make install` leaves besides the shipped files: separately linked programs Genex never runs. */
const LEFT_OUT = [
  "bin/scalar",
  "bin/git-shell",
  "bin/git-cvsserver",
  "libexec/git-core/git-daemon",
  "libexec/git-core/git-http-backend",
  "libexec/git-core/git-http-fetch",
  "libexec/git-core/git-imap-send",
  "libexec/git-core/git-instaweb",
  "share/git-core/templates/hooks/pre-commit.sample",
  "share/bash-completion/completions/git",
];
const LICENSES = ["COPYING", "LGPL-2.1", "reftable/LICENSE", "sha1dc/LICENSE.txt"];

/** The source tarball (any bytes: the stand-in tar never reads it) and its pin. */
async function release() {
  const served = path.join(await tmpDir("git-source-"), "git-9.9.9.tar.xz");
  await writeFile(served, "git's source");
  const sha256 = createHash("sha256")
    .update(await readFile(served))
    .digest("hex");
  return { served, pin: { version: "9.9.9", url: "https://example.invalid/git-9.9.9.tar.xz", sha256 } };
}

const argValue = (args: readonly string[], name: string) =>
  args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

/** Write what `make install` would under `stage`, built for `cpu`, leaving out `without`. */
async function install(stage: string, cpu: number, without: readonly string[]): Promise<void> {
  for (const entry of [...MAC_GIT_FILES.programs, ...MAC_GIT_FILES.scripts, ...MAC_GIT_FILES.templates, ...LEFT_OUT]) {
    if (without.includes(entry)) continue;
    const file = path.join(stage, entry);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, (MAC_GIT_FILES.programs as readonly string[]).includes(entry) ? machO(cpu) : entry);
  }
  // `make install` links the dashed names to the programs.
  for (const entry of Object.keys(MAC_GIT_FILES.wrappers)) {
    if (without.includes(entry)) continue;
    const target = entry.startsWith("bin/") ? "git" : "git-remote-http";
    await mkdir(path.dirname(path.join(stage, entry)), { recursive: true });
    await symlink(target, path.join(stage, entry));
  }
}

/** Stand-ins for the network, tar, make and the built git, recording each use. */
function standIns(served: string, options: { cpu?: number; without?: readonly string[] } = {}) {
  const downloads: string[] = [];
  const runs: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  const deps: VendorMacGitDeps = {
    download: async (url, file) => {
      downloads.push(url);
      await writeFile(file, await readFile(served));
    },
    run: async (command, args, how = {}) => {
      runs.push({ command, args, ...how });
      if (command === "tar") {
        const into = args[args.indexOf("-C") + 1] ?? "";
        for (const license of LICENSES) {
          await mkdir(path.dirname(path.join(into, "git-9.9.9", license)), { recursive: true });
          await writeFile(path.join(into, "git-9.9.9", license), license);
        }
        return "";
      }
      if (command === "make") {
        const prefix = argValue(args, "prefix") ?? "";
        const stage = path.join(argValue(args, "DESTDIR") ?? "", prefix);
        await install(stage, options.cpu ?? CPU.arm64, options.without ?? []);
        return "";
      }
      return "git version 9.9.9\n";
    },
  };
  return { deps, downloads, runs };
}

/** Every file and link under `dir`, links marked: none should ship, as a development build refuses them. */
async function treeOf(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => {
      const name = path.relative(dir, path.join(entry.parentPath, entry.name));
      return entry.isSymbolicLink() ? `${name} (a link)` : name;
    })
    .sort();
}

describe("vendoring git into a macOS build", () => {
  it("builds the pinned source with Apple's tools alone and ships only what Genex reaches", async () => {
    const { served, pin } = await release();
    const cacheDir = await tmpDir("git-cache-");
    const dest = path.join(await tmpDir("git-dest-"), "git");
    const { deps, downloads, runs } = standIns(served);
    const vendored = await vendorGitForMac(dest, { arch: "arm64", cacheDir, release: pin, deps });

    const wrappers = Object.keys(MAC_GIT_FILES.wrappers);
    const shipped = [...MAC_GIT_FILES.programs, ...MAC_GIT_FILES.scripts, ...MAC_GIT_FILES.templates, ...wrappers];
    const licenses = ["COPYING", "LGPL-2.1", "licenses/reftable/LICENSE", "licenses/sha1dc/LICENSE.txt"];
    assert.deepEqual(await treeOf(dest), [...shipped, ...licenses, "SOURCE.txt"].sort());
    assert.equal(vendored.version, "9.9.9");
    assert.deepEqual(downloads, [pin.url]);

    const make = runs.find((run) => run.command === "make");
    assert.ok(make, "git is built");
    assert.equal(
      make.env?.PATH,
      "/usr/bin:/bin:/usr/sbin:/sbin",
      "no compiler, curl-config or iconv from another PATH",
    );
    for (const flag of ["RUNTIME_PREFIX=YesPlease", "NO_HOMEBREW=YesPlease", "SKIP_DASHED_BUILT_INS=YesPlease"])
      assert.ok(make.args.includes(flag), flag);
    assert.match(argValue(make.args, "CFLAGS") ?? "", /-arch arm64 .*-mmacosx-version-min=12\.0/);
    assert.match(argValue(make.args, "LDFLAGS") ?? "", /-arch arm64 .*-mmacosx-version-min=12\.0/);
    const source = await readFile(path.join(dest, "SOURCE.txt"), "utf8");
    assert.ok(source.includes(pin.url) && source.includes(pin.sha256), "the shipped copy names its exact source");
  });

  it("runs each dashed name as the program beside it, from wherever the copy is", {
    skip: process.platform === "win32" ? "the wrappers are /bin/sh scripts, run only on a Mac" : false,
  }, async () => {
    const { served, pin } = await release();
    const dest = path.join(await tmpDir("git dest with spaces-"), "git");
    await vendorGitForMac(dest, {
      arch: "arm64",
      cacheDir: await tmpDir("git-cache-"),
      release: pin,
      deps: standIns(served).deps,
    });
    // Stand-ins for the programs that answer with how they were run.
    for (const program of ["bin/git", "libexec/git-core/git-remote-http"]) {
      await writeFile(path.join(dest, program), `#!/bin/sh\necho ${path.basename(program)} "$@"\n`);
      await chmod(path.join(dest, program), 0o755);
    }
    const run = async (entry: string) =>
      (await promisify(execFile)(path.join(dest, entry), ["a b", "c"], { env: { PATH: "/usr/bin:/bin" } })).stdout;
    assert.equal(await run("bin/git-upload-pack"), "git upload-pack a b c\n");
    assert.equal(await run("bin/git-receive-pack"), "git receive-pack a b c\n");
    assert.equal(await run("bin/git-upload-archive"), "git upload-archive a b c\n");
    assert.equal(await run("libexec/git-core/git"), "git a b c\n");
    assert.equal(await run("libexec/git-core/git-remote-https"), "git-remote-http a b c\n");
  });

  it("builds for an Intel Mac when the build is for one", async () => {
    const { served, pin } = await release();
    const dest = path.join(await tmpDir("git-dest-"), "git");
    const { deps, runs } = standIns(served, { cpu: CPU.x64 });
    await vendorGitForMac(dest, { arch: "x64", cacheDir: await tmpDir("git-cache-"), release: pin, deps });
    const make = runs.find((run) => run.command === "make");
    assert.match(argValue(make?.args ?? [], "CFLAGS") ?? "", /-arch x86_64 /);
  });

  it("reuses its build: a second vendoring makes nothing and replaces what the first one left", async () => {
    const { served, pin } = await release();
    const cacheDir = await tmpDir("git-cache-");
    const dest = path.join(await tmpDir("git-dest-"), "git");
    const { deps, downloads, runs } = standIns(served);
    await vendorGitForMac(dest, { arch: "arm64", cacheDir, release: pin, deps });
    await writeFile(path.join(dest, "stale.txt"), "left over");
    await vendorGitForMac(dest, { arch: "arm64", cacheDir, release: pin, deps });
    assert.deepEqual(downloads, [pin.url]);
    assert.equal(runs.filter((run) => run.command === "make").length, 1);
    assert.equal(existsSync(path.join(dest, "stale.txt")), false);
    assert.ok((await lstat(path.join(dest, "bin", "git"))).isFile());
  });

  it("refuses source that is not the pinned bytes, and builds nothing", async () => {
    const { served, pin } = await release();
    const cacheDir = await tmpDir("git-cache-");
    const dest = path.join(await tmpDir("git-dest-"), "git");
    const { deps, runs } = standIns(served);
    await assert.rejects(
      vendorGitForMac(dest, { arch: "arm64", cacheDir, release: { ...pin, sha256: "0".repeat(64) }, deps }),
      /git source archive .* has SHA-256 [0-9a-f]{64}, not the pinned 0{64}: refusing it/,
    );
    assert.deepEqual(runs, []);
    assert.equal(existsSync(dest), false);
  });

  it("refuses a release that no longer installs a shipped file, so a new git is reviewed", async () => {
    const { served, pin } = await release();
    const { deps } = standIns(served, { without: ["libexec/git-core/git-remote-https"] });
    await assert.rejects(
      vendorGitForMac(path.join(await tmpDir("git-dest-"), "git"), {
        arch: "arm64",
        cacheDir: await tmpDir("git-cache-"),
        release: pin,
        deps,
      }),
      /git 9\.9\.9 installs no libexec\/git-core\/git-remote-https: review MAC_GIT_FILES/,
    );
  });

  it("refuses a program built for another processor than the build's", async () => {
    const { served, pin } = await release();
    const { deps } = standIns(served, { cpu: CPU.x64 });
    await assert.rejects(
      vendorGitForMac(path.join(await tmpDir("git-dest-"), "git"), {
        arch: "arm64",
        cacheDir: await tmpDir("git-cache-"),
        release: pin,
        deps,
      }),
      /bin\/git is built for x64, not arm64/,
    );
  });

  it("refuses an architecture it has no compiler flag for", async () => {
    const { served, pin } = await release();
    await assert.rejects(
      vendorGitForMac(path.join(await tmpDir("git-dest-"), "git"), {
        arch: "ppc",
        cacheDir: await tmpDir("git-cache-"),
        release: pin,
        deps: standIns(served).deps,
      }),
      /no macOS git build for the ppc architecture/,
    );
  });
});
