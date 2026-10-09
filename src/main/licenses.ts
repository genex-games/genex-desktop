/**
 * The license texts Settings → Licenses shows, read from the fixed files the build writes into
 * the app's resources (scripts/third-party-notices.mjs). The page names no path: it only asks.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LicenseTexts } from "../shared/licenses.ts";

const MESSAGE = { InvalidResources: "ENOTDIR: license resources must be a directory" };

/** A text file's contents, or null when the build did not write it. */
async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Genex's license, the bundled-package list and the project's notices from `resources`. */
export async function readLicenseTexts(resources: string): Promise<LicenseTexts> {
  const folder = await stat(resources).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  // Windows reports ENOENT for a child of a regular file. Keep a damaged package distinct
  // from a watch build that has not written its license files yet.
  if (folder && !folder.isDirectory()) throw Object.assign(new Error(MESSAGE.InvalidResources), { code: "ENOTDIR" });
  const [license, bundled, notices] = await Promise.all([
    readIfPresent(path.join(resources, "LICENSE")),
    readIfPresent(path.join(resources, "third-party", "NOTICE.md")),
    readIfPresent(path.join(resources, "third-party", "PROJECT-SOURCES.md")),
  ]);
  return { license, bundled, notices };
}
