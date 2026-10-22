/**
 * Where Genex keeps its own files (Settings → Storage, on Windows): the folder in use, a folder
 * the person picked to move them to, and why a folder was refused or a move did not happen. The
 * move itself runs when Genex restarts, before anything opens those files. Browser-safe: the
 * renderer reads it through `dataFolder`, `chooseDataFolder` and `moveDataFolder`.
 */

/** Why a folder was refused, or why a move did not happen. */
export const DataFolderProblem = {
  /** Not offered here: another system, or a developer or test launch. */
  Unsupported: "unsupported",
  /** A build or a reply is under way: Genex moves its files once it ends. */
  Busy: "busy",
  /** The folder Genex already keeps its files in. */
  Same: "same",
  /** Inside Genex's own files, a game's folder or Genex's install. */
  Overlaps: "overlaps",
  /** A network drive or a shared folder. */
  Network: "network",
  /** A removable drive, such as a USB stick. */
  Removable: "removable",
  /** A drive whose file system keeps no permissions (FAT32, exFAT), so agents could reach everything. */
  FileSystem: "file-system",
  /** A folder that already has files in it. */
  NotEmpty: "not-empty",
  /** Not enough free space for Genex's files. */
  NoSpace: "no-space",
  /** The folder could not be made, or its access could not be limited to this account. */
  Unwritable: "unwritable",
  /** A file was in use while it moved. */
  InUse: "in-use",
  /** The folder, or its drive, was gone when Genex restarted. */
  Missing: "missing",
  /** Anything else; the log says what. */
  Failed: "failed",
} as const;
export type DataFolderProblem = (typeof DataFolderProblem)[keyof typeof DataFolderProblem];

/** Every problem, for checking one read back from disk. */
export const DATA_FOLDER_PROBLEMS: ReadonlySet<string> = new Set(Object.values(DataFolderProblem));

/** A move that did not happen: where it was going and why. */
export interface DataMoveFailed {
  to: string;
  problem: DataFolderProblem;
}

/** What Settings → Storage shows about the folder Genex keeps its files in. */
export interface DataFolderState {
  /** The folder in use. */
  dir: string;
  /** Whether Storage offers to move it: Windows, in the normal profile. */
  movable: boolean;
  /** The last move that did not happen, until the next one is asked for. */
  failed: DataMoveFailed | null;
  /** Old folders holding files changed after a move (someone's edits there), which stay. */
  kept: string[];
}

/** A folder picked in Settings: where the files would go and how much would move, or why not. */
export type DataFolderChoice =
  | { ok: true; to: string; bytes: number }
  | { ok: false; to: string | null; problem: DataFolderProblem };

/** A move under way, as the start window shows it. */
export interface DataMoveProgress {
  to: string;
  /** Bytes copied so far. */
  done: number;
  /** Bytes to copy; 0 while Genex is still counting them. */
  total: number;
}
