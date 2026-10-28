/**
 * The frames a video is rendered from, found in a game folder before Genex commits it. An agent
 * that renders a flythrough writes hundreds of numbered pictures beside the video; committed, each
 * save point and chat checkpoint copies gigabytes into the game's history for a video of a few
 * megabytes. A sequence of enough numbered pictures in one folder, large enough together, that the
 * game does not track yet reads as such a dump, and its names become an ignore rule
 * (`frame_[0-9][0-9][0-9][0-9].png`): the frames stay on disk, out of every commit after, while the
 * video and every other file beside them, other numbered pictures included, stay in.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { assetFormat } from "../shared/game-assets.ts";
import { isPlaceableBase, type PlacedRule } from "../shared/project-workspace.ts";
import { pathExists } from "./fsx.ts";
import { ownIgnoreFile } from "./nested-repos.ts";
import { gitOrNull } from "./snapshots.ts";

/** The fewest frames of one sequence that read as a render's (five seconds at 24 fps). */
export const RENDER_DUMP_MIN_FILES = 120;
/** The fewest bytes those frames hold together: a sprite animation's small frames stay in history. */
export const RENDER_DUMP_MIN_BYTES = 32 * 1024 * 1024;
/** How many files are looked at at once. */
const FILES_AT_ONCE = 64;

/**
 * A frame's name: a plain prefix, its number, a plain extension (`frame_0001.png`, `Shot.0001.exr`,
 * `12.jpg`). A name of other characters is never a frame: an ignore line could not say its prefix.
 */
const FRAME_NAME = /^([A-Za-z0-9._-]*?)(\d+)\.([A-Za-z0-9]+)$/;
/** One digit in a frames rule. */
const DIGIT = "[0-9]";
/** An ignore line a frames rule writes: `<folder>/<prefix>[0-9]…[0-9].<extension>`. */
const FRAMES_LINE = /^(.+)\/([A-Za-z0-9._-]*?)((?:\[0-9\])+)\.([A-Za-z0-9]+)$/;
/**
 * A folder name an ignore line says as itself: letters, digits, `.`, `_`, `-` and inner spaces.
 * Anything else (a glob, `!`, `#`, a backslash, a line break, an edge space) git would read as
 * more than the name, so such a folder is never named.
 */
const PLAIN_SEGMENT = /^[\p{L}\p{N}._-](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}._-])?$/u;

/**
 * A frame's name taken apart (`padded`: its number starts with a zero, as `0001`); null for a file
 * that is no numbered picture.
 */
function frameName(rel: string): { prefix: string; digits: number; padded: boolean; extension: string } | null {
  if (assetFormat(rel)?.kind !== "image") return null;
  const [, prefix = "", digits = "", extension = ""] = FRAME_NAME.exec(path.posix.basename(rel)) ?? [];
  if (!digits) return null;
  return { prefix, digits: digits.length, padded: digits.length > 1 && digits.startsWith("0"), extension };
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

/**
 * The rule leaving out one sequence's frames of one number width (`frame_[0-9][0-9][0-9][0-9].png`),
 * placed at their folder; null for a folder an ignore line cannot name as itself.
 */
function framesRule(folder: string, prefix: string, digits: number, extension: string): PlacedRule | null {
  if (!isPlaceableBase(folder) || folder === ".") return null;
  if (!folder.split("/").every((segment) => PLAIN_SEGMENT.test(segment))) return null;
  return { base: folder, pattern: `${prefix}${DIGIT.repeat(digits)}.${extension}` };
}

/** `items` grouped by `keyOf`, in the order each key first appears. */
function groupBy(items: readonly string[], keyOf: (item: string) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** Whether one sequence's frames are enough, and large enough together, to be a render's dump. */
async function isRenderDump(dir: string, frames: readonly string[]): Promise<boolean> {
  return frames.length >= RENDER_DUMP_MIN_FILES && (await bytesOf(dir, frames)) >= RENDER_DUMP_MIN_BYTES;
}

/** A frame's folder and sequence (its prefix and extension as spelled), the unit a dump is judged by. */
const sequenceOf = (rel: string): string => {
  const name = frameName(rel);
  return `${path.posix.dirname(rel)}\0${name?.prefix}\0${name?.extension}`;
};

/**
 * A sequence's runs, each judged on its own: the frames of each zero-padded width (`0001` … `0120`),
 * and the frames numbered without padding together (`1` … `120` spans three widths). A stray
 * `1.png` beside `0001.png` … `0120.png` is a run of one, never a render's.
 */
function runsOf(sequence: readonly string[]): string[][] {
  const widths = [...groupBy(sequence, (rel) => String(frameName(rel)?.digits)).values()];
  const isPadded = (run: readonly string[]) => run.some((rel) => frameName(rel)?.padded);
  const unpadded = widths.filter((run) => !isPadded(run)).flat();
  return [...widths.filter(isPadded), ...(unpadded.length ? [unpadded] : [])];
}

/** A dumped run's rules: one per number width its frames use (`1.png` … `1200.png` has four). */
function sequenceRules(sequence: readonly string[]): PlacedRule[] {
  const byWidth = new Map<number, PlacedRule | null>();
  for (const rel of sequence) {
    const name = frameName(rel);
    if (!name || byWidth.has(name.digits)) continue;
    byWidth.set(name.digits, framesRule(path.posix.dirname(rel), name.prefix, name.digits, name.extension));
  }
  return [...byWidth.values()].filter((rule) => rule !== null);
}

/**
 * The rules for each sequence of frames of `dir` that is a render's dump the repository does not
 * track and does not ignore yet.
 */
async function newFramesRules(dir: string): Promise<PlacedRule[]> {
  const frames = (await untrackedFiles(dir)).filter((rel) => frameName(rel) && path.posix.dirname(rel) !== ".");
  const rules: PlacedRule[] = [];
  for (const run of [...groupBy(frames, sequenceOf).values()].flatMap(runsOf))
    if (await isRenderDump(dir, run)) rules.push(...sequenceRules(run));
  return rules;
}

/**
 * The frames rules the folder's `.gitignore` already holds. Their frames are ignored now, so no
 * walk finds them again; a restore cleans what the rules it is answered leave out, and an older
 * save point's ignore file may not have the line yet, so these are answered for as long as it stays.
 */
async function keptFramesRules(dir: string): Promise<PlacedRule[]> {
  const text = (await ownIgnoreFile(dir)) ?? "";
  return text.split("\n").flatMap((line) => {
    const [, folder = "", prefix = "", digits = "", extension = ""] = FRAMES_LINE.exec(line.trim()) ?? [];
    const rule = digits ? framesRule(folder, prefix, digits.length / DIGIT.length, extension) : null;
    return rule ? [rule] : [];
  });
}

/**
 * The rules leaving out the frames of each render dumped in `dir`, placed at their folder, for
 * frames found now and for those a rule already leaves out. The folder's other files (the video,
 * a poster, a texture named `tile1.png`) stay in history. None for a folder that is no repository.
 */
export async function renderDumpRules(dir: string): Promise<PlacedRule[]> {
  if (!(await pathExists(path.join(dir, ".git")))) return [];
  const rules = [...(await keptFramesRules(dir)), ...(await newFramesRules(dir))];
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule.base}/${rule.pattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
