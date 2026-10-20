/**
 * The frames a video is rendered from, found in a game folder before Genex commits it. An agent
 * that renders a flythrough writes hundreds of numbered pictures beside the video; committed, each
 * save point and chat checkpoint copies gigabytes into the game's history for a video of a few
 * megabytes. A folder of enough numbered pictures, large enough together, that the game does not
 * track yet reads as such a dump, and its folder becomes an ignore rule: it stays on disk, out of
 * every commit after.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { assetFormat } from "../shared/game-assets.ts";
import type { PlacedRule } from "../shared/project-workspace.ts";
import { pathExists } from "./fsx.ts";
import { gitOrNull } from "./snapshots.ts";

/** The fewest numbered pictures in one folder that read as a render's frames (five seconds at 24 fps). */
export const RENDER_DUMP_MIN_FILES = 120;
/** The fewest bytes those pictures hold together: a sprite animation's small frames stay in history. */
export const RENDER_DUMP_MIN_BYTES = 32 * 1024 * 1024;
/** How many files are looked at at once. */
const FILES_AT_ONCE = 64;

/** A frame's name ends in its number: `frame_0001.png`, `Shot.0001.exr`, `12.jpg`. */
const NUMBERED_STEM = /\d+$/;
/**
 * A folder name an ignore line says as itself: letters, digits, `.`, `_`, `-` and inner spaces.
 * Anything else (a glob, `!`, `#`, a backslash, a line break, an edge space) git would read as
 * more than the name, so such a folder is never named.
 */
const PLAIN_SEGMENT = /^[\p{L}\p{N}._-](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}._-])?$/u;

/** Whether a game-relative file is a numbered picture. */
function isNumberedPicture(rel: string): boolean {
  if (assetFormat(rel)?.kind !== "image") return false;
  const name = path.posix.basename(rel);
  return NUMBERED_STEM.test(name.slice(0, name.lastIndexOf(".")));
}

/**
 * The untracked, unignored files of a repository, game-relative and POSIX; none when git cannot say,
 * or when `dir` has no repository of its own (git would answer for one around it).
 */
async function untrackedFiles(dir: string): Promise<string[]> {
  if (!(await pathExists(path.join(dir, ".git")))) return [];
  const out = await gitOrNull(dir, ["ls-files", "-z", "-o", "--exclude-standard"]);
  return (out ?? "").split("\0").filter(Boolean);
}

/** The bytes the regular files of `files` hold at `dir`, never through a link. */
async function bytesOf(dir: string, files: readonly string[]): Promise<number> {
  let total = 0;
  for (let at = 0; at < files.length; at += FILES_AT_ONCE) {
    const batch = files.slice(at, at + FILES_AT_ONCE);
    const infos = await Promise.all(batch.map((rel) => lstat(path.join(dir, rel)).catch(() => null)));
    for (const info of infos) if (info?.isFile()) total += info.size;
  }
  return total;
}

/** A folder's rule, placed at its parent; null for one an ignore line cannot name as itself. */
function folderRule(folder: string): PlacedRule | null {
  const segments = folder.split("/");
  if (!segments.every((segment) => PLAIN_SEGMENT.test(segment))) return null;
  return { base: path.posix.dirname(folder), pattern: `${path.posix.basename(folder)}/` };
}

/**
 * The rules leaving out each folder of `dir` that holds a render's frames the repository does not
 * track yet: one rule per folder, placed at its parent. None for a folder that is no repository.
 */
export async function renderDumpRules(dir: string): Promise<PlacedRule[]> {
  const byFolder = new Map<string, string[]>();
  for (const rel of await untrackedFiles(dir)) {
    if (!isNumberedPicture(rel)) continue;
    const folder = path.posix.dirname(rel);
    if (folder === ".") continue;
    const frames = byFolder.get(folder);
    if (frames) frames.push(rel);
    else byFolder.set(folder, [rel]);
  }
  const rules: PlacedRule[] = [];
  for (const [folder, frames] of byFolder) {
    if (frames.length < RENDER_DUMP_MIN_FILES) continue;
    const rule = folderRule(folder);
    if (rule && (await bytesOf(dir, frames)) >= RENDER_DUMP_MIN_BYTES) rules.push(rule);
  }
  return rules;
}
