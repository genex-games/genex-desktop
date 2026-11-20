/**
 * Links for tests that must also run on Windows, where making a symbolic link needs a privilege
 * (an administrator, or Developer Mode) most computers lack. A folder is linked with a junction
 * there, which needs none and which Node reports as a link just the same; a file can only be a
 * symbolic link, so a case about a linked file runs where {@link FILE_LINKS} says one can be made.
 */
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "./tmp.ts";

/** Links `at` to the folder `target`, an absolute path that need not exist. */
export const linkFolder = (target: string, at: string): Promise<void> =>
  symlink(target, at, process.platform === "win32" ? "junction" : "dir");

/** Links `at` to the file `target`; only where {@link FILE_LINKS} is true. */
export const linkFile = (target: string, at: string): Promise<void> => symlink(target, at, "file");

async function canLinkFiles(): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const dir = await tmpDir("studio-link-probe-");
  await writeFile(path.join(dir, "target"), "");
  return symlink(path.join(dir, "target"), path.join(dir, "link"), "file").then(
    () => true,
    () => false,
  );
}

/** Whether this computer lets a test link a file: always off Windows, on it only with the privilege. */
export const FILE_LINKS = await canLinkFiles();
