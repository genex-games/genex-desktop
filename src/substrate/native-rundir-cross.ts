/**
 * The run directory a Windows or Linux host starts a game from (M7): `<root>/<runId>` (host-only,
 * 0700, never one that exists already) holding `bundle/` (what the game reads and runs) and
 * `state/{home,captures}` (its only writable folder), assembled from a cross build
 * `admitCrossOutput` admitted and the lock's store ANGLE. What the host trusts is read and checked
 * before the run directory exists: the store's `manifest.json` must be the lock's pin, and every
 * store file the digest that manifest gives it (the Windows DLLs through `checkWindowsAngleDll`).
 * - Windows: `bundle/game.exe` is written from the very bytes admission read (`out/game.exe` is
 *   never read again); the store's `libEGL.dll`, `libGLESv2.dll` and `d3dcompiler_47.dll` go
 *   beside it under those names (a build's own copies are dropped); the admitted assets keep
 *   their on-disk spelling (`Assets/` stays `Assets/`: Windows ignores case).
 * - Linux: exactly the admitted files but the build's copies of host files; the game's bytes are
 *   checked against admission's digest before they are written, 0755; the store's host files
 *   (ANGLE, the Vulkan loader, SwiftShader and its ICD file) sit at the bundle root beside it,
 *   where `$ORIGIN` and the ICD's relative `library_path` find them.
 * Files from `out/` are opened through the shared no-follow open (`bundle-walk.ts`) from the real
 * path admission recorded, and `out/` must still be the folder admission read before and after the
 * copies (`outFolderChange`): `out/` itself or a folder below it swapped for a link or another
 * folder, a link at a name, a FIFO, a second hard link, a vanished file or an asset that became a
 * program refuses the run, and any refusal after the run directory exists removes it. The Mac's
 * run directory is `native-bundle.ts`'s `assembleRunDir`.
 */
import { createHash } from "node:crypto";
import { chmod, type FileHandle, mkdir, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import { BuildTarget } from "../shared/game-project.ts";
import { NATIVE_CROSS_EXECUTABLES, NativeError, NativeRefusal } from "../shared/native-contract.ts";
import { openBundleFile, WalkProblem } from "./bundle-walk.ts";
import { readRegularFile } from "./fsx.ts";
import { isRunId, RunDirLayout, removeRunDir } from "./native-bundle.ts";
import {
  type CrossAdmission,
  type CrossAngle,
  type DesktopTarget,
  NATIVE_CROSS_MANIFEST_MAX_BYTES,
  type OutFolder,
  outFolderChange,
  programRefusal,
} from "./native-cross-admission.ts";
import { LINUX_ELF_MAX_BYTES, LINUX_HOST_FILES, linuxHostFiles } from "./native-gate-elf.ts";
import { checkWindowsAngleDll, WINDOWS_BUNDLE_LIMITS, WindowsAngleDll, windowsAnglePins } from "./native-gate-pe.ts";

/** Chunk size of an asset copy. */
const COPY_CHUNK_BYTES = 1024 ** 2;
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
const MANIFEST_FILE = "manifest.json";
/** The folders a run's `state/` starts with. */
const STATE_SUBFOLDERS = [RunDirLayout.Home, RunDirLayout.Captures] as const;

/** The refusal a file in `out/` earns when its second open stops; anything not named is not the admitted file. */
const OPEN_REFUSAL: Partial<Record<WalkProblem, NativeRefusal>> = {
  [WalkProblem.Symlink]: NativeRefusal.Symlink,
  [WalkProblem.Swapped]: NativeRefusal.Symlink,
  [WalkProblem.HardLink]: NativeRefusal.HardLink,
};

const MESSAGE = {
  BadRunId: "a run id is 12 to 32 lowercase hexadecimal characters",
  RunDirTaken: (dir: string) => `the run directory ${dir} exists already`,
  NotAdmitted: (target: string) => `the admission holds no ${target} bundle`,
  ManifestUnreadable: (dir: string, why: string) => `${dir}/${MANIFEST_FILE} cannot be read: ${why}`,
  ManifestDigest: (dir: string) => `${dir}/${MANIFEST_FILE} is not the manifest the toolchain lock pins`,
  ManifestPins: (dir: string) => `${dir}/${MANIFEST_FILE} does not pin the host's files`,
  StoreUnreadable: (name: string, why: string) => `the store's ${name} cannot be read: ${why}`,
  StoreDigest: (name: string) => `the store's ${name} is not the pinned build`,
  HardLink: (file: string) => `${file} has another hard link`,
  GameChanged: (file: string) => `${file} is not the executable admission read`,
  TooLarge: (file: string) => `${file} is larger than ${LINUX_ELF_MAX_BYTES} bytes`,
  BecameProgram: (file: string) => `${file} became a program after admission`,
} as const;

/** What {@link assembleCrossRunDir} assembles: a run in `<root>/<runId>` from an admitted cross build. */
export interface CrossRunDirRequest {
  /** `layout.nativeRuns`. */
  root: string;
  runId: string;
  admitted: Extract<CrossAdmission, { ok: true }>;
  angle: CrossAngle;
}

/** An assembled cross run directory, every path realpath'd. */
export interface AssembledCrossRunDir {
  runDir: string;
  /** `<runDir>/bundle/game.exe` or `<runDir>/bundle/game`. */
  exe: string;
  /** `<runDir>/bundle` (read-only to the game). */
  bundle: string;
  /** `<runDir>/state` (the only writable path). */
  state: string;
}

/** A file the host writes from bytes it has already checked. */
interface HostFile {
  name: string;
  bytes: Uint8Array;
  mode: number;
}

/** Everything a run directory is assembled from, read and checked before it exists. */
interface RunPlan {
  target: DesktopTarget;
  out: string;
  /** The folder admission read at `out`: copies are read from its real path while it is still that folder. */
  outFolder: OutFolder;
  /** The game's file name at the bundle root. */
  exe: string;
  /** Written at the bundle root: the Windows game's admitted bytes and the store's files. */
  hostFiles: HostFile[];
  /** Copied from `out/` under the same relative path. */
  copies: string[];
  /** Linux: the game, copied from `out/` and checked against admission's digest. */
  game: { file: string; sha256: string } | null;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const angleRefusal = (message: string) => new NativeError(NativeRefusal.AngleDigest, message);
const notExecutable = (message: string) => new NativeError(NativeRefusal.NotAnExecutable, message);

/** Folds any other failure into the typed refusal: what cannot be checked is not run. */
function asRefusal(error: unknown): NativeError {
  return error instanceof NativeError ? error : notExecutable(errorMessage(error));
}

/** The store ANGLE's manifest as JSON: no link, within 1 MiB, the very file the lock pins. */
async function pinnedManifest(angle: CrossAngle): Promise<unknown> {
  const bytes = await readRegularFile(path.join(angle.dir, MANIFEST_FILE), NATIVE_CROSS_MANIFEST_MAX_BYTES).catch(
    (error: unknown) => {
      throw angleRefusal(MESSAGE.ManifestUnreadable(angle.dir, errorMessage(error)));
    },
  );
  if (sha256(bytes) !== angle.manifestSha256) throw angleRefusal(MESSAGE.ManifestDigest(angle.dir));
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw angleRefusal(MESSAGE.ManifestUnreadable(angle.dir, errorMessage(error)));
  }
}

/** One store file's bytes: no link, no FIFO, within `maxBytes`. */
function storeFile(angle: CrossAngle, name: string, maxBytes: number): Promise<Buffer> {
  return readRegularFile(path.join(angle.dir, name), maxBytes).catch((error: unknown) => {
    throw angleRefusal(MESSAGE.StoreUnreadable(name, errorMessage(error)));
  });
}

/** Windows: the admitted game's bytes, the store's three DLLs (each checked against its pin) and the assets. */
async function windowsPlan(admitted: CrossRunDirRequest["admitted"], angle: CrossAngle): Promise<RunPlan> {
  const bundle = admitted.windows;
  if (!bundle) throw notExecutable(MESSAGE.NotAdmitted(BuildTarget.Windows));
  const pins = windowsAnglePins(await pinnedManifest(angle));
  if (pins === null) throw angleRefusal(MESSAGE.ManifestPins(angle.dir));
  const exe = NATIVE_CROSS_EXECUTABLES[BuildTarget.Windows];
  const hostFiles: HostFile[] = [{ name: exe, bytes: bundle.exe.bytes, mode: EXECUTABLE_MODE }];
  for (const name of Object.values(WindowsAngleDll)) {
    const bytes = await storeFile(angle, name, WINDOWS_BUNDLE_LIMITS.angleBytes);
    const refused = checkWindowsAngleDll(name, bytes, pins);
    if (refused) throw new NativeError(refused.refusal, refused.detail);
    hostFiles.push({ name, bytes, mode: FILE_MODE });
  }
  return {
    target: BuildTarget.Windows,
    out: admitted.out,
    outFolder: admitted.outFolder,
    exe,
    hostFiles,
    copies: [...bundle.assets],
    game: null,
  };
}

/** Linux: the store's host files (each its manifest digest), the admitted files but the host copies, and the game. */
async function linuxPlan(admitted: CrossRunDirRequest["admitted"], angle: CrossAngle): Promise<RunPlan> {
  const bundle = admitted.linux;
  if (!bundle) throw notExecutable(MESSAGE.NotAdmitted(BuildTarget.Linux));
  let digests: Record<string, string>;
  try {
    digests = linuxHostFiles(await pinnedManifest(angle));
  } catch (error) {
    throw error instanceof NativeError ? error : angleRefusal(MESSAGE.ManifestPins(angle.dir));
  }
  const hostFiles: HostFile[] = [];
  for (const name of LINUX_HOST_FILES) {
    const bytes = await storeFile(angle, name, LINUX_ELF_MAX_BYTES);
    if (sha256(bytes) !== digests[name]) throw angleRefusal(MESSAGE.StoreDigest(name));
    hostFiles.push({ name, bytes, mode: FILE_MODE });
  }
  const skipped = new Set<string>([...bundle.hostCopies, ...LINUX_HOST_FILES, bundle.exe]);
  return {
    target: BuildTarget.Linux,
    out: admitted.out,
    outFolder: admitted.outFolder,
    exe: bundle.exe,
    hostFiles,
    copies: bundle.files.filter((file) => !skipped.has(file)),
    game: { file: bundle.exe, sha256: bundle.exeSha256 },
  };
}

/** Opens an admitted file in `out/` again: the shared no-follow open, and still one link only. */
async function openAdmitted(out: { given: string; real: string }, file: string): Promise<FileHandle> {
  const opened = await openBundleFile(out.given, file, { realRoot: out.real });
  if (!opened.ok) throw new NativeError(OPEN_REFUSAL[opened.problem] ?? NativeRefusal.NotAnExecutable, opened.detail);
  if (opened.info.nlink <= 1) return opened.handle;
  await opened.handle.close();
  throw new NativeError(NativeRefusal.HardLink, MESSAGE.HardLink(file));
}

/** Copies one admitted asset into the bundle, refusing it if it became a program for `target`. */
async function copyAsset(plan: RunPlan, out: { given: string; real: string }, bundle: string, file: string) {
  const source = await openAdmitted(out, file);
  try {
    const to = path.join(bundle, ...file.split("/"));
    await mkdir(path.dirname(to), { recursive: true, mode: FOLDER_MODE });
    const target = await open(to, "wx", FILE_MODE);
    try {
      const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
      for (let first = true; ; first = false) {
        const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        const program = first ? programRefusal(plan.target, chunk.subarray(0, bytesRead)) : null;
        if (program) throw new NativeError(program, MESSAGE.BecameProgram(file));
        await target.write(chunk, 0, bytesRead);
      }
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/** The Linux game's bytes from `out/`, read once, refused unless they are the ones admission hashed. */
async function admittedGame(out: { given: string; real: string }, game: { file: string; sha256: string }) {
  const handle = await openAdmitted(out, game.file);
  try {
    const { size } = await handle.stat();
    if (size > LINUX_ELF_MAX_BYTES) throw notExecutable(MESSAGE.TooLarge(game.file));
    const bytes = Buffer.alloc(size);
    let total = 0;
    while (total < size) {
      const { bytesRead } = await handle.read(bytes, total, size - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const read = bytes.subarray(0, total);
    if (sha256(read) !== game.sha256) throw notExecutable(MESSAGE.GameChanged(game.file));
    return read;
  } finally {
    await handle.close();
  }
}

/** Writes a new file with exactly `mode` (the umask cannot widen or narrow it). */
async function writeNew(file: string, bytes: Uint8Array, mode: number): Promise<void> {
  await writeFile(file, bytes, { flag: "wx", mode });
  await chmod(file, mode);
}

/** Refuses (`symlink`) unless `out/` is still the folder admission read. */
async function requireAdmittedOut(plan: RunPlan): Promise<void> {
  const changed = await outFolderChange(plan.out, plan.outFolder);
  if (changed !== null) throw new NativeError(NativeRefusal.Symlink, changed);
}

/**
 * Writes `bundle/`: the host's files, the Linux game, then the copies from `out/`, read from the
 * real path admission recorded while `out/` is still that folder (checked before and after).
 */
async function writeBundle(bundle: string, plan: RunPlan): Promise<void> {
  await mkdir(bundle, { mode: FOLDER_MODE });
  for (const file of plan.hostFiles) await writeNew(path.join(bundle, file.name), file.bytes, file.mode);
  await requireAdmittedOut(plan);
  const out = { given: plan.outFolder.real, real: plan.outFolder.real };
  if (plan.game) await writeNew(path.join(bundle, plan.game.file), await admittedGame(out, plan.game), EXECUTABLE_MODE);
  for (const file of plan.copies) await copyAsset(plan, out, bundle, file);
  await requireAdmittedOut(plan);
}

/** Makes `state/` and its starting folders, host-only. */
async function writeState(state: string): Promise<void> {
  await mkdir(state, { mode: FOLDER_MODE });
  for (const folder of STATE_SUBFOLDERS) await mkdir(path.join(state, folder), { mode: FOLDER_MODE });
  await chmod(state, FOLDER_MODE);
}

/** Makes `<root>/<runId>` (host-only), refusing one that exists already and leaving it alone; returns its real path. */
async function createRunDir(root: string, runId: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: FOLDER_MODE });
  const runDir = path.join(await realpath(root), runId);
  await mkdir(runDir, { mode: FOLDER_MODE }).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "EEXIST" ? new NativeError(NativeRefusal.Unsupported, MESSAGE.RunDirTaken(runDir)) : error;
  });
  await chmod(runDir, FOLDER_MODE);
  return runDir;
}

/**
 * Assembles a Windows or Linux run directory from an admitted cross build: the run id is checked
 * first (nothing is written for a bad one), the store files next (nothing is written when one is
 * not its pin), then the run directory is made and filled. Throws `NativeError`; after the run
 * directory exists, any refusal removes it.
 */
export async function assembleCrossRunDir(request: CrossRunDirRequest): Promise<AssembledCrossRunDir> {
  if (!isRunId(request.runId)) throw new NativeError(NativeRefusal.Unsupported, MESSAGE.BadRunId);
  const { admitted, angle } = request;
  const plan = await (admitted.target === BuildTarget.Windows ? windowsPlan : linuxPlan)(admitted, angle).catch(
    (error: unknown) => {
      throw asRefusal(error);
    },
  );
  const runDir = await createRunDir(request.root, request.runId).catch((error: unknown) => {
    throw asRefusal(error);
  });
  try {
    const bundle = path.join(runDir, RunDirLayout.Bundle);
    const state = path.join(runDir, RunDirLayout.State);
    await writeBundle(bundle, plan);
    await writeState(state);
    return { runDir, exe: await realpath(path.join(bundle, plan.exe)), bundle, state };
  } catch (error) {
    await removeRunDir(runDir).catch(() => {});
    throw asRefusal(error);
  }
}
