/**
 * Copy-on-write clones of a whole folder, where the host's filesystem has them: a clone shares
 * the source's blocks until one side rewrites a file, so it costs no disk at first.
 *
 * - macOS: APFS's `clonefile(2)` through the system's `/bin/cp -c`. Node's `copyFile` cannot
 *   clone there: `COPYFILE_FICLONE` copies every byte and `COPYFILE_FICLONE_FORCE` is `ENOSYS`.
 *   `cp -c` falls back to a copy off APFS, so a root clones only when it lies on the same kind of
 *   volume as the system's `/`, which is APFS on every macOS Genex runs on.
 * - Linux: a reflink per file (`COPYFILE_FICLONE_FORCE`, the `FICLONE` ioctl), which btrfs and
 *   XFS answer and ext4 refuses: a probe file cloned in the root says which.
 * - Windows: none. Node exposes no ReFS block cloning, and NTFS has none.
 *
 * Every clone keeps the source's timestamps (cargo compares them), refuses a source holding a
 * link or a special file, and leaves nothing at its destination when it fails.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as FS } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, statfs, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { StudioPlatform } from "../shared/boot.ts";

/** A host's copy-on-write clone of a folder. */
export interface TreeCloner {
  /** Whether folders under `root` clone copy-on-write. */
  supported: (root: string) => Promise<boolean>;
  /** Clones the folder `from` to the absent `to`; throws, leaving nothing at `to`, where it cannot. */
  clone: (from: string, to: string) => Promise<void>;
  /** Clones the one regular file `from` to the absent `to`, timestamps kept; throws, leaving nothing at `to`, where it cannot. */
  cloneFile?: CloneFile;
}

/** One file cloned copy-on-write from `from` to the absent `to`; it throws where the filesystem cannot clone. */
export type CloneFile = (from: string, to: string) => Promise<void>;

/** Runs a program outside any sandbox (the host's own `cp` on its own folders). */
export type CloneExec = (file: string, args: readonly string[]) => Promise<void>;

/** What a host's cloner is built over; each part defaults to the real one. */
export interface TreeClonerDeps {
  cloneFile?: CloneFile;
  exec?: CloneExec;
  /** A filesystem's type number, as `statfs` answers it. */
  fsType?: (dir: string) => Promise<number>;
}

/** macOS's own `cp`: `-c` clones through clonefile(2), `-R` a folder, `-p` with its timestamps. */
const MAC_CP = "/bin/cp";
const MAC_CP_ARGS = ["-c", "-R", "-p", "--"] as const;
/** The same for one file: `-c` clones it, `-p` keeps its timestamps and mode. */
const MAC_CP_FILE_ARGS = ["-c", "-p", "--"] as const;
/** The folder whose filesystem a Mac's clone check compares a root's with: the system volume, APFS. */
const MAC_SYSTEM_VOLUME = "/";
/** The probe file a Linux clone check writes into a root, and removes. */
const PROBE_PREFIX = ".clone-probe-";

const MESSAGE = {
  notRegular: (file: string) => `${file} is a link or a special file, and a clone never takes one`,
} as const;

const execFileAsync = promisify(execFile);

/** A file cloned copy-on-write, never copied: `COPYFILE_FICLONE_FORCE` fails where the filesystem has no clones. */
export const cloneFileOnWrite: CloneFile = async (from, to) => {
  await copyFile(from, to, FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE_FORCE);
};

/** The host's cloner for `platform`, or null where the host has none (Windows). */
export function hostTreeCloner(platform: NodeJS.Platform, deps: TreeClonerDeps = {}): TreeCloner | null {
  if (platform === StudioPlatform.Windows) return null;
  if (platform === StudioPlatform.Mac) return macCloner(deps);
  return fileCloner(deps.cloneFile ?? cloneFileOnWrite);
}

/** macOS: the root's volume is the system's kind (APFS), and `cp -c` clones the whole folder in one run. */
function macCloner(deps: TreeClonerDeps): TreeCloner {
  const fsType = deps.fsType ?? (async (dir: string) => Number((await statfs(dir)).type));
  const exec = deps.exec ?? (async (file, args) => void (await execFileAsync(file, [...args])));
  return {
    supported: async (root) => {
      const [here, system] = await Promise.all([fsType(root), fsType(MAC_SYSTEM_VOLUME)]);
      return here === system;
    },
    clone: async (from, to) => {
      await refuseLinks(from);
      await execLeavingNothing(exec, [...MAC_CP_ARGS, from, to], to);
    },
    cloneFile: async (from, to) => {
      if (!(await lstat(from)).isFile()) throw new Error(MESSAGE.notRegular(from));
      await execLeavingNothing(exec, [...MAC_CP_FILE_ARGS, from, to], to);
    },
  };
}

/** Runs the system's `cp` with `args`; when it fails, nothing is left at `to`. */
async function execLeavingNothing(exec: CloneExec, args: readonly string[], to: string): Promise<void> {
  try {
    await exec(MAC_CP, args);
  } catch (error) {
    await rm(to, { recursive: true, force: true });
    throw error;
  }
}

/** Linux and the rest: a probe file clones in the root, and the folder clones file by file. */
function fileCloner(cloneFile: CloneFile): TreeCloner {
  return {
    supported: async (root) => {
      const probe = path.join(root, `${PROBE_PREFIX}${randomUUID()}`);
      const clone = `${probe}.clone`;
      try {
        await writeFile(probe, PROBE_PREFIX, { flag: "wx" });
        await cloneFile(probe, clone);
        return true;
      } catch {
        return false;
      } finally {
        await rm(clone, { force: true }).catch(() => {});
        await rm(probe, { force: true }).catch(() => {});
      }
    },
    clone: (from, to) => cloneTreeByFile(from, to, cloneFile),
    cloneFile: async (from, to) => {
      if (!(await lstat(from)).isFile()) throw new Error(MESSAGE.notRegular(from));
      await cloneFile(from, to);
    },
  };
}

/**
 * Clones the folder `from` to the absent `to`, every file by `cloneFile` with the source's
 * timestamps, every folder made afresh. A link or special file in `from`, or a file that does not
 * clone, refuses the whole clone, which then leaves nothing at `to`.
 */
export async function cloneTreeByFile(from: string, to: string, cloneFile: CloneFile): Promise<void> {
  await mkdir(to);
  try {
    await cloneInto(from, to, cloneFile);
  } catch (error) {
    await rm(to, { recursive: true, force: true });
    throw error;
  }
}

async function cloneInto(from: string, to: string, cloneFile: CloneFile): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(target);
      await cloneInto(source, target, cloneFile);
      continue;
    }
    if (!entry.isFile()) throw new Error(MESSAGE.notRegular(source));
    await cloneFile(source, target);
    const info = await lstat(source);
    await utimes(target, info.atime, info.mtime);
  }
}

/** Throws when `dir` holds anything but folders and regular files, at any depth, or is not a folder itself. */
async function refuseLinks(dir: string): Promise<void> {
  if (!(await lstat(dir)).isDirectory()) throw new Error(MESSAGE.notRegular(dir));
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await refuseLinks(child);
    else if (!entry.isFile()) throw new Error(MESSAGE.notRegular(child));
  }
}
