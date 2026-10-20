/**
 * Links a hostile-input row plants before its test runs. On Windows a symbolic link needs a
 * privilege (or Developer Mode) that an elevated CI runner has and a developer's account may not,
 * but a junction, Windows' link to a folder, needs none, and lstat, readdir and realpath see it as
 * a link the way they see a symbolic link elsewhere. So a row that links a folder runs everywhere,
 * and one that links a file skips only on a Windows account that can't make that link.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Whether this account can make a symbolic link to a file: tried once, in a folder of its own. */
function canLinkFiles(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "studio-link-probe-"));
  try {
    writeFileSync(path.join(dir, "target"), "");
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The skip reason of a test that links a file, on a Windows account without the privilege to. */
export const FILE_LINKS = process.platform === "win32" && !canLinkFiles() && "file links need privileges on Windows";

/**
 * Links `at` to the folder `target`: a junction to its absolute path on Windows, a symbolic link
 * to `target` as given elsewhere.
 */
export async function linkFolder(target: string, at: string): Promise<void> {
  if (process.platform === "win32") await symlink(path.resolve(path.dirname(at), target), at, "junction");
  else await symlink(target, at);
}
