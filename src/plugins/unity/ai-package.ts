/**
 * Genex's play-time AI package for Unity (`com.genex.ai`, shipped in `packages/`) embedded in a
 * game's Unity project as `Packages/com.genex.ai/`: Unity loads an embedded package with no line in
 * the manifest, and fetches its one dependency (Newtonsoft JSON) itself. Every file is written as
 * shipped; a file the person changed is kept beside it as `.mine`, and their own files stay. Nothing
 * is written through a link.
 */
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFile, writeFileNoFollow } from "../../substrate/fsx.ts";

/** The package's name, its folder in a project's Packages and in the plugin's `packages/`. */
export const AI_PACKAGE = "com.genex.ai";
/** The package as this plugin ships it, beside its backend (the source tree's, or the built `backend.mjs`'s). */
export const SHIPPED_AI_PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "packages", AI_PACKAGE);
/** Where Unity keeps a project's packages. */
const PACKAGES_FOLDER = "Packages";
const MINE_SUFFIX = ".mine";
/** The largest package file read back from a project: the shipped ones are a few kilobytes. */
const MAX_FILE_BYTES = 1024 * 1024;

/** Why the package was not embedded. Wire values: never rename one. */
export const AiPackageRefusal = {
  /** Unity has never opened the project: it has no Packages folder yet. */
  NoPackages: "no-packages",
  /** A folder or file on the way is a link, so Genex won't write through it. */
  Link: "link",
} as const;
export type AiPackageRefusal = (typeof AiPackageRefusal)[keyof typeof AiPackageRefusal];

/** A refused embed, with a code its caller words. */
export class AiPackageError extends Error {
  readonly code: AiPackageRefusal;
  constructor(code: AiPackageRefusal) {
    super(code);
    this.name = "AiPackageError";
    this.code = code;
  }
}

/** The shipped package's files by path inside it (forward slashes), no dotfiles. */
async function shippedFiles(source: string, prefix = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(path.join(source, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [inner, text] of await shippedFiles(source, name)) files.set(inner, text);
    else if (entry.isFile()) files.set(name, await readFile(path.join(source, name), "utf8"));
  }
  return files;
}

/** Refuses a path that is a link; a missing one is fine. */
async function assertNoLink(file: string): Promise<void> {
  if ((await lstat(file).catch(() => null))?.isSymbolicLink()) throw new AiPackageError(AiPackageRefusal.Link);
}

/** A file of the embedded package as text, or null: missing, a link or not a plain file. */
async function textOf(file: string): Promise<string | null> {
  const bytes = await readRegularFile(file, MAX_FILE_BYTES).catch(() => null);
  return bytes ? bytes.toString("utf8") : null;
}

/** Where the package stands in the project at `root`: every file as shipped, none, or something between. */
export async function aiPackageState(root: string, source: string): Promise<"current" | "outdated" | "missing"> {
  const folder = path.join(root, PACKAGES_FOLDER, AI_PACKAGE);
  const shipped = [...(await shippedFiles(source))];
  const now = await Promise.all(shipped.map(async ([name]) => textOf(path.join(folder, ...name.split("/")))));
  if (now.every((text) => text === null)) return "missing";
  return shipped.every(([, text], index) => now[index] === text) ? "current" : "outdated";
}

/** Every folder from the package's own down to the file's, none a link, made when missing. */
async function folderFor(folder: string, name: string): Promise<string> {
  let at = folder;
  for (const part of name.split("/").slice(0, -1)) {
    at = path.join(at, part);
    await assertNoLink(at);
    await mkdir(at, { recursive: true });
  }
  return at;
}

/**
 * Embeds the package in the project at `root` (its real path). Answers whether anything changed and
 * the files kept as `.mine`.
 */
export async function embedAiPackage(root: string, source: string): Promise<{ changed: boolean; kept: string[] }> {
  const packages = path.join(root, PACKAGES_FOLDER);
  await assertNoLink(packages);
  if (!(await lstat(packages).catch(() => null))?.isDirectory()) throw new AiPackageError(AiPackageRefusal.NoPackages);
  const folder = path.join(packages, AI_PACKAGE);
  await assertNoLink(folder);
  await mkdir(folder, { recursive: true });
  const kept: string[] = [];
  let changed = false;
  for (const [name, text] of await shippedFiles(source)) {
    const file = path.join(await folderFor(folder, name), path.basename(name));
    await assertNoLink(file);
    const now = await textOf(file);
    if (now === text) continue;
    if (now !== null) {
      await writeFileNoFollow(`${file}${MINE_SUFFIX}`, now);
      kept.push(name);
    }
    await writeFileNoFollow(file, text);
    changed = true;
  }
  return { changed, kept };
}
