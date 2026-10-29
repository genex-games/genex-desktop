/**
 * Vendor Git for Windows into a Windows build, so Genex runs on a PC without Git installed: the
 * sandbox runs every agent command in Git Bash, and the host keeps game snapshots with git
 * (`src/substrate/windows-sandbox.ts` uses this copy on a PC without Git; `scripts/package-git.cjs` puts it in
 * the package's resources).
 *
 * The release is Git for Windows' portable edition, pinned by version and SHA-256, and an archive
 * whose digest differs is refused before anything is unpacked. It is a self-extracting 7-Zip
 * archive, so the build needs 7-Zip (`7z`; GitHub's Windows runners have it). The archive is
 * cached, so a second build makes no request.
 *
 * What a person or an agent never reaches through Genex is left out ({@link GIT_FOR_WINDOWS_TRIM}),
 * which halves the files the installer carries and the sandbox grants. Every path listed must
 * exist in the pinned release, so a newer one is reviewed against the list rather than shipped
 * with whatever it adds.
 *
 * The portable edition asks for its `post-install.bat` once unpacked. Of its steps, the DLL copies
 * into `libexec/git-core` are already in the archive, and the rest (`/dev/shm`, `/etc/mtab`, copies
 * of this machine's `hosts` and `services`) concern only programs Genex does not run, or would
 * ship the build machine's own files; it is removed with its scripts, as its last step does.
 *
 * Moving to a newer Git: change the pin below, check every trimmed path still exists, then run
 * the Windows package job, which installs the app and runs a chat turn in the sandbox with it.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type Download, fetchTo, type PinnedFile, verifiedArchive } from "./pinned-download.ts";

/** A Git for Windows release: its version, where its portable edition is, and that archive's SHA-256. */
export interface GitForWindowsRelease extends PinnedFile {
  version: string;
}

/** The release a build ships, by Node's name for the build's architecture. */
export const GIT_FOR_WINDOWS_RELEASES: Readonly<Record<string, GitForWindowsRelease>> = {
  x64: {
    version: "2.56.0.windows.2",
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe",
    sha256: "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b",
  },
};

/**
 * What the build removes, by why. Host git never prompts, the system config left names no
 * credential helper ({@link withoutCredentialHelper}), and sandboxed commands run with the helper
 * switched off and no terminal, so none of this is reachable through Genex.
 */
export const GIT_FOR_WINDOWS_TRIM = {
  /** HTML and man pages, which `git help` opens in a browser. */
  docs: ["ucrt64/share/doc"],
  /** Git's graphical tools, gitk and git gui, and the Tcl/Tk they run on. */
  guis: [
    "cmd/git-gui.exe",
    "cmd/gitk.exe",
    "ucrt64/bin/gitk",
    "ucrt64/bin/tcl86.dll",
    "ucrt64/bin/tclsh.exe",
    "ucrt64/bin/tclsh86.exe",
    "ucrt64/bin/tk86.dll",
    "ucrt64/bin/wish.exe",
    "ucrt64/bin/wish86.exe",
    "ucrt64/lib/reg1.3",
    "ucrt64/lib/tcl8",
    "ucrt64/lib/tcl8.6",
    "ucrt64/lib/tclConfig.sh",
    "ucrt64/lib/thread2.8.13",
    "ucrt64/lib/tk8.6",
    "ucrt64/lib/tkConfig.sh",
    "ucrt64/libexec/git-core/git-citool",
    "ucrt64/libexec/git-core/git-gui",
    "ucrt64/libexec/git-core/git-gui--askpass",
    "ucrt64/libexec/git-core/git-gui--askyesno",
    "ucrt64/libexec/git-core/git-gui.tcl",
    "ucrt64/libexec/git-core/tcl86.dll",
    "ucrt64/libexec/git-core/tk86.dll",
    "ucrt64/share/git-gui",
  ],
  /**
   * Vim and its runtime. Nothing runs an editor in a terminal here, and without `vi` a git command
   * that wants one fails at once rather than waiting on input no one can type.
   */
  editor: [
    "usr/bin/ex.exe",
    "usr/bin/rview.exe",
    "usr/bin/rvim.exe",
    "usr/bin/vi",
    "usr/bin/view.exe",
    "usr/bin/vim.exe",
    "usr/bin/vimdiff.exe",
    "usr/bin/vimtutor",
    "usr/share/vim",
  ],
  /** The run-once setup the portable edition asks for (see this file's header). */
  postInstall: ["post-install.bat", "etc/post-install"],
} as const;

/**
 * Git Credential Manager: a .NET app with its own windows, beside git in `ucrt64/bin` and copied
 * into `libexec/git-core` with the other DLLs. Matched by name, since it is dozens of assemblies;
 * its executable is the one name that must be there.
 */
const CREDENTIAL_MANAGER = {
  dirs: ["ucrt64/bin", "ucrt64/libexec/git-core"],
  required: "ucrt64/bin/git-credential-manager.exe",
  file: /^(?:(?:Atlassian|Avalonia|GitHub|GitLab|HarfBuzzSharp|MicroCom|Microsoft|SkiaSharp|System)(?:\..+)?\.dll|(?:av_libglesv2|gcmcore|libHarfBuzzSharp|libSkiaSharp|msalruntime)\.dll|git-credential-(?:manager|helper-selector)\.exe(?:\.config)?)$/,
} as const;

/**
 * Git's system config, which every git that does not set `GIT_CONFIG_SYSTEM` reads: the release
 * names `credential.helper = helper-selector`, a program the trim removes with the credential
 * manager, so an HTTPS git call there would fail on a missing helper instead of asking for none.
 */
const SYSTEM_CONFIG = "etc/gitconfig";

/** The system config without its `[credential]` section; everything else as the release has it. */
export function withoutCredentialHelper(config: string): string {
  const kept: string[] = [];
  let inCredential = false;
  for (const line of config.split("\n")) {
    const section = /^\s*\[([^\]\s"]+)/.exec(line);
    if (section) inCredential = section[1]?.toLowerCase() === "credential";
    if (!inCredential && line) kept.push(line);
  }
  return kept.map((line) => `${line}\n`).join("");
}

/** What a vendored Git must have: Git Bash for the sandbox and `cmd\git.exe` for the host. */
const REQUIRED = ["bin/bash.exe", "cmd/git.exe", "LICENSE.txt"] as const;

const MESSAGE = {
  arch: (arch: string) => `no Git for Windows release is pinned for the ${arch} architecture`,
  trimMissing: (version: string, entry: string) =>
    `Git for Windows ${version} has no ${entry}: review GIT_FOR_WINDOWS_TRIM against this release`,
  missing: (entry: string) => `the unpacked Git for Windows has no ${entry}`,
} as const;

/** What vendoring touches outside itself, so a test can stand in for the network and 7-Zip. */
export interface VendorGitDeps {
  download: Download;
  /** Run a tool (7-Zip) to completion. */
  run(command: string, args: string[]): Promise<void>;
}

/** What a vendored Git came to. */
export interface VendoredGit {
  version: string;
  files: number;
  bytes: number;
}

const defaultDeps: VendorGitDeps = {
  download: fetchTo,
  run: async (command, args) => {
    await promisify(execFile)(command, args);
  },
};

/** 7-Zip: `GENEX_7Z` when set, its default install folder on Windows, else `7z` on PATH. */
export function sevenZip(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): string {
  if (env.GENEX_7Z) return env.GENEX_7Z;
  const installed = path.win32.join(env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe");
  return process.platform === "win32" && exists(installed) ? installed : "7z";
}

/** Every file under `dir`: how many, and their bytes. */
async function measure(dir: string): Promise<{ files: number; bytes: number }> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
  return { files: files.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
}

/** Remove the trimmed paths, each of which must exist, Git Credential Manager and the config naming it. */
async function trim(dest: string, version: string): Promise<void> {
  const listed = [...Object.values(GIT_FOR_WINDOWS_TRIM).flat(), CREDENTIAL_MANAGER.required, SYSTEM_CONFIG];
  for (const entry of listed)
    if (!existsSync(path.join(dest, entry))) throw new Error(MESSAGE.trimMissing(version, entry));
  for (const entry of Object.values(GIT_FOR_WINDOWS_TRIM).flat())
    await rm(path.join(dest, entry), { recursive: true, force: true });
  for (const dir of CREDENTIAL_MANAGER.dirs) {
    const names = (await readdir(path.join(dest, dir))).filter((name) => CREDENTIAL_MANAGER.file.test(name));
    await Promise.all(names.map((name) => rm(path.join(dest, dir, name), { force: true })));
  }
  const config = path.join(dest, SYSTEM_CONFIG);
  await writeFile(config, withoutCredentialHelper(await readFile(config, "utf8")));
}

/**
 * Put the pinned Git for Windows, trimmed, in `dest` (replacing what was there): the portable
 * edition for `arch`, with its license and its components' licenses.
 */
export async function vendorGitForWindows(
  dest: string,
  options: {
    arch?: string;
    cacheDir: string;
    release?: GitForWindowsRelease;
    deps?: VendorGitDeps;
    sevenZip?: string;
  },
): Promise<VendoredGit> {
  const arch = options.arch ?? process.arch;
  const release = options.release ?? GIT_FOR_WINDOWS_RELEASES[arch];
  if (!release) throw new Error(MESSAGE.arch(arch));
  const deps = options.deps ?? defaultDeps;
  const archive = await verifiedArchive("Git for Windows", release, options.cacheDir, deps.download);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  // Quiet: no file list or progress on stdout, only errors.
  await deps.run(options.sevenZip ?? sevenZip(), ["x", "-y", "-bso0", "-bsp0", `-o${dest}`, archive]);
  await trim(dest, release.version);
  for (const entry of REQUIRED) if (!existsSync(path.join(dest, entry))) throw new Error(MESSAGE.missing(entry));
  return { version: release.version, ...(await measure(dest)) };
}
