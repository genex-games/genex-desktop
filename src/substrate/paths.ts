/**
 * Path containment, in one place: is a path inside a root, and does a relative path from an
 * untrusted writer (a plugin package, the harness) resolve inside its root once links are
 * followed.
 *
 * Two kinds of check, and they are not interchangeable:
 *  - **Lexical** (`isInside`, `isBelow`): the two paths as written, resolved against each other
 *    but never against the disk. Right for a path the caller has already realpathed, or one that
 *    does not exist yet. A link inside the root can still point out; that is the next kind.
 *  - **Real** (`containedReal`): both sides realpathed, so a link out of the root is caught.
 *    Every path a harness or a plugin names is checked this way before anything touches it.
 *
 * The filesystem root contains nothing but itself here: the prefix test is `root + separator`,
 * which for `/` is `//`. No owned root is `/`, and a check that fails closed on a misconfigured
 * root is the one to keep.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";

const MESSAGE = {
  InvalidPath:
    "Invalid plugin path: name a file by its relative path inside its folder, with / between folders (no absolute path, backslash, control character, empty, . or .. part)",
  EscapesRoot: "Path escapes authorized root",
} as const;

/** A control character or a backslash: never part of a path an untrusted writer may name. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point: they are refused.
const CONTROL_OR_BACKSLASH = /[\x00-\x1f\\]/;

/** `target` is `root` or lies under it, lexically (both resolved, links not followed). */
export function isInside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

/**
 * A relative path as the workspace rules, the wire and git read it: `/`-separated. Windows's
 * `path.relative` answers with `\`; elsewhere a `\` is part of a file name and stays.
 */
export function toPosixRelative(rel: string, platform: NodeJS.Platform = process.platform): string {
  return platform === StudioPlatform.Windows ? rel.replaceAll("\\", "/") : rel;
}

/**
 * `text` as a person reads it: the workspace prefix stripped wherever it appears (file arguments
 * and shell commands alike), and a bare mention of the workspace itself as `.`. On Windows a tool
 * may spell the workspace with either slash and follow it with either separator; all of them count.
 */
export function relativizeWorkspace(text: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  const windows = platform === StudioPlatform.Windows;
  const trailing = windows ? /[\\/]+$/ : /\/+$/;
  const base = cwd.replace(trailing, "");
  if (!base) return text;
  const spellings = windows ? [...new Set([base, base.replaceAll("\\", "/")])] : [base];
  const separators = windows ? ["\\", "/"] : ["/"];
  let out = text;
  for (const spelling of spellings) for (const separator of separators) out = out.split(spelling + separator).join("");
  for (const spelling of spellings) out = out.split(spelling).join(".");
  return out;
}

/** Claude Code's folder in a project: the settings, hooks, commands and skills a session there loads. */
const CLAUDE_PROJECT_FOLDER = ".claude";
/** A name's trailing dots and spaces, which Windows drops when it opens the name. */
const WINDOWS_TRAILING = /[. ]+$/;

/**
 * Does a relative path go through a `.claude` folder, at any depth? Named the way a
 * case-insensitive file system and Windows read a name: in any case, without trailing dots or
 * spaces, and without a Windows stream suffix (`.claude::$DATA`).
 */
export function throughClaudeFolder(rel: string): boolean {
  return throughProjectFolder(rel, CLAUDE_PROJECT_FOLDER);
}

/** Git metadata is host-owned, including nested repositories and Windows path spellings. */
export function throughGitFolder(rel: string): boolean {
  return throughProjectFolder(rel, ".git");
}

function throughProjectFolder(rel: string, folder: string): boolean {
  return rel.split(/[\\/]+/).some((segment) => {
    const name = (segment.split(":")[0] ?? "").replace(WINDOWS_TRAILING, "").toLowerCase();
    return name === folder;
  });
}

/** `a` and `b` name the same place, lexically (both resolved, links not followed). */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** `target` lies strictly under `root`, lexically: `root` itself is not below it. */
export function isBelow(root: string, target: string): boolean {
  const base = path.resolve(root);
  return path.resolve(target).startsWith(base + path.sep);
}

/**
 * A package- or workspace-relative path as an untrusted writer gave it, checked for shape only:
 * non-empty, `/`-separated, no absolute path, no backslash or control character, and no empty,
 * `.` or `..` segment. Returns it unchanged, or throws. It says nothing about links: resolve it
 * with {@link containedReal} before reading or writing through it.
 */
export function assertRelativePath(file: string): string {
  if (!isPlainRelativePath(file)) throw new Error(MESSAGE.InvalidPath);
  return file;
}

/** The shape `assertRelativePath` accepts. */
function isPlainRelativePath(file: unknown): file is string {
  if (typeof file !== "string" || !file) return false;
  if (CONTROL_OR_BACKSLASH.test(file) || path.isAbsolute(file)) return false;
  return file.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

/**
 * The real path of `rel` inside `root`, which must exist and lie strictly under the root's own
 * real path once every link on the way is followed; throws otherwise.
 */
export async function containedReal(root: string, rel: string): Promise<string> {
  assertRelativePath(rel);
  const base = await realpath(root);
  const target = await realpath(path.join(base, rel));
  if (!target.startsWith(base + path.sep)) throw new Error(MESSAGE.EscapesRoot);
  return target;
}
