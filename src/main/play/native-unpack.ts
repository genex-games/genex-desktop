/**
 * A verified Mac build unpacked into a staging folder and made Genex's: its zip listed and checked
 * before anything is written (`native-zip.ts`), unpacked by `ditto` without quarantine, every link
 * in it resolved inside it, the app it names found and checked (a signature, even ad hoc; a binary
 * for this Mac's processor), then given a bundle id of Genex's own (`games.genex.play.<slug>`) and
 * signed again ad hoc, so the game can only ever read and write its own preferences. A Linux build
 * is unpacked by the app itself (`unpackZip`), checked the same way, and its program must be an ELF
 * binary for this computer's processor; Linux has no signature or bundle to check.
 */
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { InstallFailure, type NativeBuild, NativeArch, type NativeHost } from "../../shared/play-native.ts";
import { elfArch } from "../core/native-builds.ts";
import { InstallError } from "./native-download.ts";
import { listZip, unpackZip, ZipEntryKind, ZipError, ZipRefusal } from "./native-zip.ts";

/** The execute bits a game's program needs, for its owner and everyone. */
const RUNNABLE = 0o111;
/** How long one tool may run on a game: unpacking or signing a large one takes a while. */
const TOOL_TIMEOUT_MS = 20 * MINUTE_MS;
/** How much larger than the catalog says the unpacked game may be: block rounding and metadata. */
const UNPACKED_SLACK = 1.05;
const UNPACKED_SLACK_BYTES = 64 * 1024 ** 2;

/** The macOS tools the unpack runs, by full path. */
const TOOL = {
  Ditto: "/usr/bin/ditto",
  Codesign: "/usr/bin/codesign",
  Lipo: "/usr/bin/lipo",
  Plutil: "/usr/bin/plutil",
} as const;

/**
 * The Info.plist key a game's app sets (to true) to open in a window: Play opens every other game
 * full screen. The agent sets it when the person asks for a window, then signs the app again.
 */
export const WINDOWED_KEY = "GenexWindowed";

/** The prefix of every installed game's bundle id: Genex's own preference domains. */
export const GAME_BUNDLE_PREFIX = "games.genex.play.";

/** A Linux game's app inside its version folder: the folder itself. */
const LINUX_APP = ".";

/** A finished tool run. */
export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one program by full path with an argument list, never through a shell. */
export type ToolRun = (file: string, args: string[], options: { timeoutMs: number }) => Promise<ToolResult>;

/** The most output one tool run keeps. */
const TOOL_OUTPUT_MAX_BYTES = 4 * 1024 ** 2;

/** {@link ToolRun} on this computer: the program by its full path, its exit code and output, never a throw for a failure. */
export const runTool: ToolRun = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: options.timeoutMs, maxBuffer: TOOL_OUTPUT_MAX_BYTES }, (error, stdout, stderr) => {
      const failed = error && typeof error.code === "number" ? error.code : null;
      const code = error ? failed : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** What the unpack learned about the app it installed, for the launcher. */
export interface UnpackedApp {
  /**
   * The app's folder inside the version folder when it is not the build's entry: a Linux build's
   * program sits among its files, so its app is the whole version folder (`.`).
   */
  entry?: string;
  /** The executable inside the app, relative to it (`Contents/MacOS/Game`, `Game.x86_64`). */
  executable: string;
  /** The bundle id it now has, and its name (what macOS names its temporary save folders after). */
  bundleId: string;
  bundleName: string;
  /** The app asks to open in a window ({@link WINDOWED_KEY}), not full screen. */
  windowed: boolean;
}

/** The processor names `lipo` reports that each architecture runs. */
const RUNS: Record<NativeHost["arch"], readonly string[]> = {
  [NativeArch.Arm64]: ["arm64", "arm64e"],
  [NativeArch.X64]: ["x86_64", "x86_64h"],
};

const refused = (failure: InstallFailure, detail: string) => new InstallError(failure, detail);

/** Run a tool and answer its output, or throw `failure` when it does not succeed. */
async function tool(run: ToolRun, file: string, args: string[], failure: InstallFailure): Promise<string> {
  const result = await run(file, args, { timeoutMs: TOOL_TIMEOUT_MS }).catch((error: unknown) => ({
    code: null,
    stdout: "",
    stderr: String(error),
  }));
  if (result.code !== 0) throw refused(failure, `${path.basename(file)}: ${result.stderr.trim().slice(0, 200)}`);
  return result.stdout;
}

/** The most a build's archive may unpack to: what the catalog states, and some slack. */
const unpackedCap = (build: NativeBuild) => Math.ceil(build.installedBytes * UNPACKED_SLACK) + UNPACKED_SLACK_BYTES;

/** What `step` answers, or the install failure a refused archive is. */
async function zipStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (!(error instanceof ZipError)) throw error;
    const failure = error.refusal === ZipRefusal.TooLarge ? InstallFailure.TooLarge : InstallFailure.UnsafeArchive;
    throw refused(failure, error.message);
  }
}

/** The archive's entries checked, or the install failure it is. */
const checkedListing = (archive: string, build: NativeBuild) => zipStep(() => listZip(archive, unpackedCap(build)));

/**
 * Walk the unpacked tree without following links: every link must resolve to somewhere inside it
 * (links in a chain included), and nothing may be a device, a pipe or a socket.
 */
async function assertContained(root: string): Promise<void> {
  const base = await realpath(root);
  const pending = [base];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(at);
      else if (entry.isSymbolicLink()) await assertLinkInside(base, at);
      else if (!entry.isFile()) throw refused(InstallFailure.UnsafeArchive, `special file ${entry.name}`);
    }
  }
}

/** Throw unless the link at `at` resolves to somewhere inside `base` (a chain of links included). */
async function assertLinkInside(base: string, at: string): Promise<void> {
  const landed = await realpath(at).catch(() => null);
  if (landed === base || landed?.startsWith(base + path.sep)) return;
  throw refused(InstallFailure.UnsafeArchive, `link ${path.basename(at)} -> ${await readlink(at)}`);
}

/** A plist value of the app, or "" when it has none. */
async function plistValue(run: ToolRun, plist: string, key: string): Promise<string> {
  const result = await run(TOOL.Plutil, ["-extract", key, "raw", "-o", "-", plist], { timeoutMs: TOOL_TIMEOUT_MS });
  return result.code === 0 ? result.stdout.trim() : "";
}

/** The app bundle the build names, checked as a real folder with a plist and an executable inside it. */
async function appOf(run: ToolRun, staging: string, entry: string): Promise<{ app: string; executable: string }> {
  const app = path.join(staging, entry);
  const info = await lstat(app).catch(() => null);
  if (!info?.isDirectory()) throw refused(InstallFailure.EntryMissing, entry);
  const plist = path.join(app, "Contents", "Info.plist");
  if (!(await lstat(plist).catch(() => null))?.isFile()) throw refused(InstallFailure.EntryMissing, "no Info.plist");
  const name = await plistValue(run, plist, "CFBundleExecutable");
  if (!name || name.includes("/") || name === "." || name === "..")
    throw refused(InstallFailure.EntryMissing, "no executable");
  const executable = path.join("Contents", "MacOS", name);
  const program = await lstat(path.join(app, executable)).catch(() => null);
  if (!program?.isFile()) throw refused(InstallFailure.EntryMissing, executable);
  return { app, executable };
}

/**
 * The app's program set runnable: a Mac app packed on Windows (a Godot game exported and published
 * there) carries no execute bit, since Windows's disks keep none. A signature doesn't cover it.
 */
async function makeRunnable(program: string): Promise<void> {
  const { mode } = await lstat(program);
  if ((mode & RUNNABLE) !== RUNNABLE) await chmod(program, mode | RUNNABLE);
}

/** Whether the binary runs on `host`: its own processor, or Intel through Rosetta. */
async function assertRunsOn(run: ToolRun, program: string, host: NativeHost): Promise<void> {
  const archs = (await tool(run, TOOL.Lipo, ["-archs", program], InstallFailure.UnsupportedOs)).trim().split(/\s+/);
  const own = archs.some((arch) => RUNS[host.arch].includes(arch));
  const translated = host.arch === NativeArch.Arm64 && host.rosetta === true;
  const intel = translated && archs.some((arch) => RUNS[NativeArch.X64].includes(arch));
  if (!own && !intel) throw refused(InstallFailure.UnsupportedOs, archs.join(" "));
}

/**
 * Unpack the verified `archive` of `build` into `staging` (a new, empty folder) and make the app
 * Genex's: checked before and after unpacking, its bundle id `games.genex.play.<slug>`, signed
 * again ad hoc. Throws {@link InstallError} with the failure it is.
 */
export async function unpackMacBuild(
  run: ToolRun,
  archive: string,
  staging: string,
  build: NativeBuild,
  game: { slug: string; host: NativeHost },
): Promise<UnpackedApp> {
  const listing = await checkedListing(archive, build);
  const top = build.entry;
  if (!listing.entries.some((entry) => entry.name === top || entry.name.startsWith(`${top}/`)))
    throw refused(InstallFailure.EntryMissing, top);
  await mkdir(staging, { recursive: true });
  await tool(run, TOOL.Ditto, ["-x", "-k", "--noqtn", archive, staging], InstallFailure.UnsafeArchive);
  await assertContained(staging);
  const { app, executable } = await appOf(run, staging, top);
  await makeRunnable(path.join(app, executable));
  await tool(run, TOOL.Codesign, ["--verify", "--deep", "--strict", app], InstallFailure.Unsigned);
  await assertRunsOn(run, path.join(app, executable), game.host);
  const plist = path.join(app, "Contents", "Info.plist");
  const bundleId = `${GAME_BUNDLE_PREFIX}${game.slug}`;
  const bundleName = (await plistValue(run, plist, "CFBundleName")) || path.basename(executable);
  const windowed = (await plistValue(run, plist, WINDOWED_KEY)) === "true";
  await tool(run, TOOL.Plutil, ["-replace", "CFBundleIdentifier", "-string", bundleId, plist], InstallFailure.Failed);
  await tool(run, TOOL.Codesign, ["--force", "--deep", "--sign", "-", app], InstallFailure.Unsigned);
  await tool(run, TOOL.Codesign, ["--verify", "--deep", "--strict", app], InstallFailure.Unsigned);
  return { executable, bundleId, bundleName, windowed };
}

/**
 * Unpack the verified `archive` of a Linux `build` into `staging` (a new, empty folder): checked
 * before and after unpacking, its program (the build's entry) a regular file, an ELF binary for
 * this computer's processor, and runnable. The whole version folder is the game's app. Throws
 * {@link InstallError} with the failure it is.
 */
export async function unpackLinuxBuild(
  archive: string,
  staging: string,
  build: NativeBuild,
  game: { slug: string; host: NativeHost },
): Promise<UnpackedApp> {
  const listing = await checkedListing(archive, build);
  const named = listing.entries.find((entry) => entry.name === build.entry);
  if (named?.kind !== ZipEntryKind.File) throw refused(InstallFailure.EntryMissing, build.entry);
  await zipStep(() => unpackZip(archive, staging, unpackedCap(build)));
  await assertContained(staging);
  const program = path.join(staging, build.entry);
  if (!(await lstat(program).catch(() => null))?.isFile()) throw refused(InstallFailure.EntryMissing, build.entry);
  const arch = await elfArch(program);
  if (arch !== game.host.arch) throw refused(InstallFailure.UnsupportedOs, arch ?? "not an ELF program");
  await makeRunnable(program);
  return {
    entry: LINUX_APP,
    executable: build.entry,
    bundleId: `${GAME_BUNDLE_PREFIX}${game.slug}`,
    bundleName: path.posix.basename(build.entry),
    windowed: false,
  };
}
