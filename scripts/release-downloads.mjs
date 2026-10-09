import { constants } from "node:fs";
import { copyFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LINUX_STABLE_COPIES } from "./release-policy.mjs";

/**
 * Copy each Linux package to its version-free name beside it (LINUX_STABLE_COPIES) and return the
 * copies' paths. Every maker folder is checked before anything is written: it lies inside `root`,
 * holds exactly one regular package of its kind, and any version-free file already there is a
 * regular file from an earlier run, which is replaced.
 */
export async function copyStableDownloads(root) {
  const realRoot = await realpath(root);
  const copies = [];
  for (const { folder, name } of LINUX_STABLE_COPIES) copies.push(await planCopy(realRoot, folder, name));
  for (const { source, target, replace } of copies) {
    if (replace) await rm(target);
    // EXCL: a link that appeared at the target since the check is refused, never written through.
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
  return copies.map((copy) => copy.target);
}

/** Where one version-free copy comes from and goes, or why it cannot be made faithfully. */
async function planCopy(root, folder, name) {
  const directory = path.join(root, folder);
  if ((await realpath(directory)) !== directory) throw new Error(`${folder} is a link out of the make`);
  const entries = await readdir(directory, { withFileTypes: true });
  const existing = entries.find((entry) => entry.name === name);
  if (existing && !existing.isFile()) throw new Error(`${folder}/${name} exists and is not a regular file`);
  const extension = path.extname(name);
  const packages = entries.filter((entry) => entry.name !== name && entry.name.endsWith(extension));
  if (packages.length !== 1)
    throw new Error(`Expected one ${extension} package in ${folder}, found ${packages.length}`);
  const [source] = packages;
  if (!source.isFile()) throw new Error(`${folder}/${source.name} is not a regular file`);
  return { source: path.join(directory, source.name), target: path.join(directory, name), replace: Boolean(existing) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const copy of await copyStableDownloads("out/make")) console.log(path.relative(process.cwd(), copy));
}
