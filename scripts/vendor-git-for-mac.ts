/**
 * Vendor git into a macOS build, so Genex runs on a Mac without Apple's developer tools: there
 * `/usr/bin/git` only stands in for the git of the Command Line Tools and, without them, asks the
 * person to install them. The app puts this copy first on PATH only on such a Mac
 * (`ensureMacGit` in `src/substrate/git-policy.ts`); a Mac with a git that runs keeps it.
 *
 * Git publishes no macOS build, and the others (Homebrew's bottles, Xcode's own git) are bound to
 * their install folders or not ours to ship, so the build compiles git's source tarball from
 * kernel.org, pinned by version and SHA-256: a tarball whose digest differs is refused before
 * anything is unpacked. Apple's compiler builds it with nothing from the build machine's PATH,
 * Homebrew or another prefix, so the programs load only libraries every Mac has (libz, libiconv,
 * libcurl, CoreFoundation, Security); `RUNTIME_PREFIX` lets git find its helpers beside itself
 * wherever the app is. It is built for the build's processor, like everything else in the bundle,
 * and the packager signs it with the app's identity. The tarball and the build are cached, so a
 * second build makes no request and compiles nothing.
 *
 * Only what Genex or an agent reaches ships ({@link MAC_GIT_FILES}): git itself, the HTTPS remote
 * helper Remix and agents clone with, and the shell-script commands with what they source. Every
 * listed path must be in the pinned release's install, so a newer git is reviewed against the list.
 *
 * Moving to a newer git: change the pin below (kernel.org's `sha256sums.asc` has the digest), check
 * the list still matches what `make install` writes, then run the Mac package job.
 */
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { machOProcessors } from "../src/main/core/native-builds.ts";
import { type Download, fetchTo, type PinnedFile, verifiedArchive } from "./pinned-download.ts";

/** A git source release: its version, where its tarball is, and that tarball's SHA-256. */
export interface GitSourceRelease extends PinnedFile {
  version: string;
}

/** The git a macOS build ships: the same version as the Windows build's Git for Windows. */
export const GIT_SOURCE_RELEASE: GitSourceRelease = {
  version: "2.56.0",
  url: "https://www.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz",
  sha256: "26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3",
};

/**
 * What ships, by kind, as paths `make install` writes under the prefix. Left out: the programs
 * nothing in Genex runs (git-daemon, git-http-backend, git-http-fetch, git-imap-send, git-shell,
 * scalar), the commands that open a tool or a browser for a person (mergetool, difftool's helper,
 * web--browse), the sample hooks (host git runs no hooks) and shell completion.
 */
export const MAC_GIT_FILES = {
  /** Compiled programs, each checked for the build's processor. */
  programs: ["bin/git", "libexec/git-core/git-remote-http", "libexec/git-core/git-sh-i18n--envsubst"],
  /** Commands git keeps as shell scripts, and the two files they source; envsubst fills their messages. */
  scripts: [
    "libexec/git-core/git-filter-branch",
    "libexec/git-core/git-merge-octopus",
    "libexec/git-core/git-merge-one-file",
    "libexec/git-core/git-merge-resolve",
    "libexec/git-core/git-quiltimport",
    "libexec/git-core/git-request-pull",
    "libexec/git-core/git-sh-i18n",
    "libexec/git-core/git-sh-setup",
    "libexec/git-core/git-submodule",
  ],
  /** What `git init` copies into a new repository. */
  templates: ["share/git-core/templates/description", "share/git-core/templates/info/exclude"],
  /**
   * The dashed names `make install` links to the programs, shipped as `/bin/sh` scripts that run the
   * program beside them: a development build refuses links in the resources. They must ship: without
   * `git-upload-pack` here, a local clone runs `/usr/bin`'s stand-in of it.
   */
  wrappers: {
    "bin/git-receive-pack": 'exec "$(dirname "$0")/git" receive-pack "$@"',
    "bin/git-upload-archive": 'exec "$(dirname "$0")/git" upload-archive "$@"',
    "bin/git-upload-pack": 'exec "$(dirname "$0")/git" upload-pack "$@"',
    "libexec/git-core/git": 'exec "$(dirname "$0")/../../bin/git" "$@"',
    "libexec/git-core/git-remote-https": 'exec "$(dirname "$0")/git-remote-http" "$@"',
  },
} as const;

/** Git's licenses, by their path in the source and where they ship. */
const LICENSES: Readonly<Record<string, string>> = {
  COPYING: "COPYING",
  "LGPL-2.1": "LGPL-2.1",
  "reftable/LICENSE": "licenses/reftable/LICENSE",
  "sha1dc/LICENSE.txt": "licenses/sha1dc/LICENSE.txt",
};

/** Node's architecture names, as Apple's compiler takes them. */
const COMPILER_ARCH: Readonly<Record<string, string>> = { arm64: "arm64", x64: "x86_64" };
/** The oldest macOS the app runs on: Electron's own `LSMinimumSystemVersion`. */
const MIN_MACOS = "12.0";
/** The prefix git is built for; with `RUNTIME_PREFIX` only its layout below matters. */
const PREFIX = "/git";
/**
 * The PATH the build runs with: Apple's own folders, so the compiler, `make` and `curl-config` are
 * Apple's. Another `curl-config` (Anaconda's, say) adds its include folder, its `iconv.h` wins over
 * the system's, and the link fails or names a library a player's Mac does not have.
 */
const BUILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** What else of the build machine's environment the build keeps: which Xcode, and where to write. */
const BUILD_ENV_KEPT = ["HOME", "TMPDIR", "DEVELOPER_DIR"] as const;
/** A wrapper script's mode: anyone may run it. */
const WRAPPER_MODE = 0o755;
/** The file in a cached build naming what it was built from. */
const BUILT_STAMP = "built.json";

const MESSAGE = {
  arch: (arch: string) => `no macOS git build for the ${arch} architecture`,
  missing: (version: string, entry: string) =>
    `git ${version} installs no ${entry}: review MAC_GIT_FILES against this release`,
  processor: (entry: string, got: string, want: string) => `${entry} is built for ${got}, not ${want}`,
  version: (said: string, version: string) => `the built git says "${said}", not git version ${version}`,
} as const;

/** How a tool is run: its folder and environment. */
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** What vendoring touches outside itself, so a test can stand in for the network, tar, make and git. */
export interface VendorMacGitDeps {
  download: Download;
  /** Run a tool to completion; its standard output. */
  run(command: string, args: string[], options?: RunOptions): Promise<string>;
}

/** What a vendored git came to. */
export interface VendoredMacGit {
  version: string;
  files: number;
  bytes: number;
}

const BUILD_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const defaultDeps: VendorMacGitDeps = {
  download: fetchTo,
  run: async (command, args, options = {}) =>
    (await promisify(execFile)(command, args, { ...options, maxBuffer: BUILD_MAX_BUFFER_BYTES })).stdout,
};

/** The make variables of a build for `compilerArch`, as `NAME=value` arguments. */
function makeVariables(compilerArch: string, stage: string): string[] {
  const target = `-arch ${compilerArch} -mmacosx-version-min=${MIN_MACOS}`;
  return [
    `prefix=${PREFIX}`,
    `DESTDIR=${stage}`,
    // Finds its helpers and templates beside itself, wherever the app is.
    "RUNTIME_PREFIX=YesPlease",
    // Nothing from Homebrew (gettext, libiconv), even on a build machine that has it.
    "NO_HOMEBREW=YesPlease",
    "NO_RUST=YesPlease",
    "NO_GETTEXT=YesPlease",
    "NO_PERL=YesPlease",
    "NO_PYTHON=YesPlease",
    "NO_TCLTK=YesPlease",
    "NO_EXPAT=YesPlease",
    // Builtins run as `git <command>`; the few dashed names git still needs are links, shipped as wrappers.
    "SKIP_DASHED_BUILT_INS=YesPlease",
    "INSTALL_SYMLINKS=YesPlease",
    `CFLAGS=-O2 ${target}`,
    `LDFLAGS=${target}`,
  ];
}

/** The build machine's environment cut down to {@link BUILD_PATH} and {@link BUILD_ENV_KEPT}. */
function buildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = BUILD_ENV_KEPT.flatMap((key) => (env[key] ? [[key, env[key]]] : []));
  return { ...Object.fromEntries(kept), PATH: BUILD_PATH, LC_ALL: "C" };
}

/** Every file under `dir`: how many, and their bytes. */
async function measure(dir: string): Promise<{ files: number; bytes: number }> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
  return { files: files.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
}

/** Whether `buildDir` holds a finished build of exactly `stamp`. */
async function builtAlready(buildDir: string, stamp: string): Promise<boolean> {
  try {
    return (await readFile(path.join(buildDir, BUILT_STAMP), "utf8")) === stamp;
  } catch {
    return false;
  }
}

/** Unpack `archive` and `make install` it into `<buildDir>/stage`, keeping git's licenses beside it. */
async function build(
  archive: string,
  buildDir: string,
  release: GitSourceRelease,
  variables: string[],
  deps: VendorMacGitDeps,
): Promise<void> {
  await rm(buildDir, { recursive: true, force: true });
  const source = path.join(buildDir, "source");
  await mkdir(source, { recursive: true });
  const env = buildEnv();
  await deps.run("tar", ["-xJf", archive, "-C", source], { env });
  const tree = path.join(source, `git-${release.version}`);
  const jobs = `-j${os.availableParallelism()}`;
  await deps.run("make", [jobs, ...variables, "install"], { cwd: tree, env });
  for (const [from, to] of Object.entries(LICENSES))
    await cp(path.join(tree, from), path.join(buildDir, "licenses", to));
  // The compiled tree is ten times the install; only the install and the licenses are kept.
  await rm(source, { recursive: true, force: true });
}

/** Copy the listed entries from the install in `installed` to `dest`, each of which must be there. */
async function copyListed(installed: string, dest: string, version: string): Promise<void> {
  const { programs, scripts, templates, wrappers } = MAC_GIT_FILES;
  const listed = [...programs, ...scripts, ...templates, ...Object.keys(wrappers)];
  for (const entry of listed) {
    const there = await lstat(path.join(installed, entry)).catch(() => null);
    if (!there) throw new Error(MESSAGE.missing(version, entry));
  }
  for (const entry of [...programs, ...scripts, ...templates])
    await cp(path.join(installed, entry), path.join(dest, entry), { preserveTimestamps: true });
  for (const [entry, command] of Object.entries(wrappers)) {
    await mkdir(path.dirname(path.join(dest, entry)), { recursive: true });
    await writeFile(path.join(dest, entry), `#!/bin/sh\n${command}\n`, { mode: WRAPPER_MODE });
  }
}

/** Refuse a program not built for exactly `arch`, then ask the built git its version where it can run. */
async function checkBuilt(dest: string, arch: string, release: GitSourceRelease, deps: VendorMacGitDeps) {
  for (const entry of MAC_GIT_FILES.programs) {
    const processors = (await machOProcessors(path.join(dest, entry))) ?? [];
    if (processors.length !== 1 || processors[0] !== arch)
      throw new Error(MESSAGE.processor(entry, processors.join("+") || "no processor", arch));
  }
  if (arch !== process.arch) return;
  const said = (await deps.run(path.join(dest, "bin", "git"), ["--version"], { env: buildEnv() })).trim();
  if (said !== `git version ${release.version}`) throw new Error(MESSAGE.version(said, release.version));
}

/** The note beside the copy naming its exact source and how it was built. */
function sourceNote(release: GitSourceRelease, variables: string[]): string {
  return [
    `git ${release.version}, built by Genex's macOS build (scripts/vendor-git-for-mac.ts) from`,
    `${release.url}`,
    `SHA-256 ${release.sha256}`,
    "The source is unmodified. It was built with:",
    `make ${variables
      .filter((variable) => !variable.startsWith("DESTDIR="))
      .map((variable) => variable.replace(/=(.* .*)$/, '="$1"'))
      .join(" ")} install`,
    "",
  ].join("\n");
}

/**
 * Put the pinned git, built for `arch` and trimmed, in `dest` (replacing what was there), with
 * git's licenses and a note naming its source.
 */
export async function vendorGitForMac(
  dest: string,
  options: { arch?: string; cacheDir: string; release?: GitSourceRelease; deps?: VendorMacGitDeps },
): Promise<VendoredMacGit> {
  const arch = options.arch ?? process.arch;
  const compilerArch = COMPILER_ARCH[arch];
  if (!compilerArch) throw new Error(MESSAGE.arch(arch));
  const release = options.release ?? GIT_SOURCE_RELEASE;
  const deps = options.deps ?? defaultDeps;
  const archive = await verifiedArchive("git source", release, options.cacheDir, deps.download);
  const buildDir = path.join(options.cacheDir, `build-${release.version}-${arch}`);
  const stage = path.join(buildDir, "stage");
  const variables = makeVariables(compilerArch, stage);
  const stamp = JSON.stringify({ sha256: release.sha256, variables });
  if (!(await builtAlready(buildDir, stamp))) {
    await build(archive, buildDir, release, variables, deps);
    await writeFile(path.join(buildDir, BUILT_STAMP), stamp);
  }
  await rm(dest, { recursive: true, force: true });
  await copyListed(path.join(stage, PREFIX), dest, release.version);
  await cp(path.join(buildDir, "licenses"), dest, { recursive: true });
  await writeFile(path.join(dest, "SOURCE.txt"), sourceNote(release, variables));
  await checkBuilt(dest, arch, release, deps);
  return { version: release.version, ...(await measure(dest)) };
}
